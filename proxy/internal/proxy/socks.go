package proxy

import (
	"context"
	"fmt"
	"net"

	"github.com/things-go/go-socks5"

	"github.com/obot-platform/octobot/proxy/internal/filter"
	"github.com/obot-platform/octobot/proxy/internal/logger"
)

// SOCKSProxy wraps go-socks5 for SOCKS5 proxying.
type SOCKSProxy struct {
	server *socks5.Server
	filter *filter.Filter
	logger *logger.Logger
}

// NewSOCKSProxy creates a new SOCKS5 proxy.
func NewSOCKSProxy(flt *filter.Filter, log *logger.Logger) *SOCKSProxy {
	s := &SOCKSProxy{
		filter: flt,
		logger: log,
	}

	s.server = socks5.NewServer(
		socks5.WithRule(&filterRule{filter: flt, logger: log}),
		socks5.WithLogger(&socksLogger{logger: log}),
		// No authentication required
		socks5.WithAuthMethods([]socks5.Authenticator{
			socks5.NoAuthAuthenticator{},
		}),
	)

	return s
}

// ServeConn serves a SOCKS5 connection.
func (s *SOCKSProxy) ServeConn(conn net.Conn) error {
	return s.server.ServeConn(conn)
}

// filterRule implements socks5.RuleSet for allowlist filtering.
type filterRule struct {
	filter *filter.Filter
	logger *logger.Logger
}

// Allow checks if a connection is allowed.
func (r *filterRule) Allow(ctx context.Context, req *socks5.Request) (context.Context, bool) {
	var host string
	if req.DestAddr.FQDN != "" {
		host = req.DestAddr.FQDN
	} else {
		host = req.DestAddr.IP.String()
	}

	allowed := r.filter.AllowHost(host)
	r.logger.LogSOCKSConnect(host, req.DestAddr.Port, allowed)

	return ctx, allowed
}

// socksLogger adapts our logger to socks5.Logger interface.
type socksLogger struct {
	logger *logger.Logger
}

func (l *socksLogger) Errorf(format string, args ...interface{}) {
	l.logger.Error(fmt.Sprintf(format, args...))
}

// Implement the full Logger interface from go-socks5
type stdLogger interface {
	Errorf(format string, args ...interface{})
}

var _ stdLogger = (*socksLogger)(nil)
