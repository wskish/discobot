package proxy

import (
	"errors"
	"fmt"
	"net"
	"sync"

	"github.com/obot-platform/octobot/proxy/internal/cert"
	"github.com/obot-platform/octobot/proxy/internal/config"
	"github.com/obot-platform/octobot/proxy/internal/filter"
	"github.com/obot-platform/octobot/proxy/internal/injector"
	"github.com/obot-platform/octobot/proxy/internal/logger"
)

// Server is the main proxy server with protocol detection.
type Server struct {
	cfg        *config.Config
	listener   net.Listener
	httpProxy  *HTTPProxy
	socksProxy *SOCKSProxy
	injector   *injector.Injector
	filter     *filter.Filter
	logger     *logger.Logger
	certMgr    *cert.Manager

	mu       sync.RWMutex
	running  bool
	shutdown chan struct{}
	wg       sync.WaitGroup
}

// New creates a new proxy server.
func New(cfg *config.Config, log *logger.Logger) (*Server, error) {
	certMgr, err := cert.NewManager(cfg.TLS.CertDir)
	if err != nil {
		return nil, fmt.Errorf("cert manager: %w", err)
	}

	inj := injector.New()
	flt := filter.New()

	s := &Server{
		cfg:      cfg,
		injector: inj,
		filter:   flt,
		logger:   log,
		certMgr:  certMgr,
		shutdown: make(chan struct{}),
	}

	s.httpProxy = NewHTTPProxy(certMgr, inj, flt, log)
	s.socksProxy = NewSOCKSProxy(flt, log)

	// Apply initial configuration
	s.ApplyConfig(cfg)

	return s, nil
}

// ApplyConfig applies runtime configuration.
func (s *Server) ApplyConfig(cfg *config.Config) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.injector.SetRules(cfg.Headers)
	s.filter.SetEnabled(cfg.Allowlist.Enabled)
	s.filter.SetAllowlist(cfg.Allowlist.Domains, cfg.Allowlist.IPs)
}

// ApplyRuntimeConfig applies runtime configuration from API.
func (s *Server) ApplyRuntimeConfig(cfg *config.RuntimeConfig, merge bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if merge {
		// PATCH: merge into existing
		if cfg.Headers != nil {
			for domain, rule := range cfg.Headers {
				if len(rule.Set) == 0 && len(rule.Append) == 0 {
					s.injector.DeleteDomain(domain)
				} else {
					s.injector.SetDomainHeaders(domain, rule)
				}
			}
		}

		if cfg.Allowlist != nil {
			if cfg.Allowlist.Enabled != nil {
				s.filter.SetEnabled(*cfg.Allowlist.Enabled)
			}
			if cfg.Allowlist.Domains != nil {
				s.filter.AddDomains(cfg.Allowlist.Domains)
			}
			if cfg.Allowlist.IPs != nil {
				s.filter.AddIPs(cfg.Allowlist.IPs)
			}
		}
	} else {
		// POST: complete overwrite
		if cfg.Headers != nil {
			s.injector.SetRules(cfg.Headers)
		} else {
			s.injector.SetRules(nil)
		}

		if cfg.Allowlist != nil {
			enabled := cfg.Allowlist.Enabled != nil && *cfg.Allowlist.Enabled
			s.filter.SetEnabled(enabled)
			s.filter.SetAllowlist(cfg.Allowlist.Domains, cfg.Allowlist.IPs)
		} else {
			s.filter.SetEnabled(false)
			s.filter.SetAllowlist(nil, nil)
		}
	}
}

// ListenAndServe starts the proxy server.
func (s *Server) ListenAndServe() error {
	addr := fmt.Sprintf(":%d", s.cfg.Proxy.Port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.listener = listener

	s.mu.Lock()
	s.running = true
	s.mu.Unlock()

	s.logger.Info("proxy server started",
		"addr", addr,
		"ca_cert", s.certMgr.GetCACertPath(),
	)

	for {
		conn, err := listener.Accept()
		if err != nil {
			select {
			case <-s.shutdown:
				return nil
			default:
				if errors.Is(err, net.ErrClosed) {
					return nil
				}
				s.logger.Error("accept error")
				continue
			}
		}

		s.wg.Add(1)
		go s.handleConnection(conn)
	}
}

func (s *Server) handleConnection(conn net.Conn) {
	defer s.wg.Done()
	defer func() { _ = conn.Close() }()

	proto, peeked, err := Detect(conn)
	if err != nil {
		s.logger.Debug("detection failed")
		return
	}

	switch proto {
	case ProtocolHTTP:
		s.httpProxy.ServeConn(peeked)
	case ProtocolSOCKS5:
		if err := s.socksProxy.ServeConn(peeked); err != nil {
			s.logger.Debug("socks error")
		}
	case ProtocolSOCKS4:
		s.logger.Warn("SOCKS4 not supported")
	default:
		s.logger.Warn("unknown protocol")
	}
}

// Close shuts down the server gracefully.
func (s *Server) Close() error {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return nil
	}
	s.running = false
	s.mu.Unlock()

	close(s.shutdown)

	if s.listener != nil {
		_ = s.listener.Close()
	}

	// Wait for all connections to finish
	s.wg.Wait()

	return nil
}

// GetInjector returns the header injector.
func (s *Server) GetInjector() *injector.Injector {
	return s.injector
}

// GetFilter returns the connection filter.
func (s *Server) GetFilter() *filter.Filter {
	return s.filter
}

// GetCACertPath returns the path to the CA certificate.
func (s *Server) GetCACertPath() string {
	return s.certMgr.GetCACertPath()
}
