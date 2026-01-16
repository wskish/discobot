package proxy

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/elazarl/goproxy"

	"github.com/obot-platform/octobot/proxy/internal/config"
	"github.com/obot-platform/octobot/proxy/internal/filter"
	"github.com/obot-platform/octobot/proxy/internal/injector"
	"github.com/obot-platform/octobot/proxy/internal/logger"
)

// testLogger creates a test logger
func testLogger(t *testing.T) *logger.Logger {
	t.Helper()
	log, err := logger.New(config.LoggingConfig{
		Level:  "error",
		Format: "text",
	})
	if err != nil {
		t.Fatalf("Failed to create logger: %v", err)
	}
	return log
}

// buildSOCKS5ConnectRequest builds a SOCKS5 connect request for a domain.
func buildSOCKS5ConnectRequest(host string, port int) []byte {
	req := make([]byte, 0, 5+len(host)+2)
	req = append(req, 0x05, 0x01, 0x00, 0x03, byte(len(host)))
	req = append(req, []byte(host)...)
	req = append(req, byte(port>>8), byte(port&0xff))
	return req
}

func TestIntegration_HTTPProxy_PlainHTTP(t *testing.T) {
	// Create a test HTTP server
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Backend", "test")
		fmt.Fprintf(w, "Hello from backend! Method: %s, Path: %s", r.Method, r.URL.Path)
	}))
	defer backend.Close()

	// Create a simple goproxy server
	proxy := goproxy.NewProxyHttpServer()
	proxy.Verbose = false

	proxyServer := httptest.NewServer(proxy)
	defer proxyServer.Close()

	// Create HTTP client that uses the proxy
	proxyURL, _ := url.Parse(proxyServer.URL)
	transport := &http.Transport{
		Proxy: http.ProxyURL(proxyURL),
	}
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}

	// Make request through proxy
	resp, err := client.Get(backend.URL + "/test")
	if err != nil {
		t.Fatalf("Request through proxy failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "Hello from backend") {
		t.Errorf("Unexpected response body: %s", body)
	}
}

func TestIntegration_HTTPProxy_HeaderInjection(t *testing.T) {
	// Create a test HTTP server that echoes headers
	var receivedHeaders http.Header
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeaders = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	// Parse backend URL to get host (without port for matching)
	backendHostPort := strings.TrimPrefix(backend.URL, "http://")
	backendHost, _, _ := net.SplitHostPort(backendHostPort)

	// Create proxy with header injection - use wildcard to match the IP
	inj := injector.New()
	inj.SetRules(config.HeadersConfig{
		backendHost: config.HeaderRule{
			Set: map[string]string{
				"Authorization": "Bearer test-token",
				"X-Custom":      "injected",
			},
		},
	})

	proxy := goproxy.NewProxyHttpServer()
	proxy.Verbose = false
	proxy.OnRequest().DoFunc(func(req *http.Request, _ *goproxy.ProxyCtx) (*http.Request, *http.Response) {
		inj.Apply(req)
		return req, nil
	})

	proxyServer := httptest.NewServer(proxy)
	defer proxyServer.Close()

	// Create HTTP client that uses the proxy
	proxyURL, _ := url.Parse(proxyServer.URL)
	transport := &http.Transport{
		Proxy: http.ProxyURL(proxyURL),
	}
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}

	// Make request through proxy
	resp, err := client.Get(backend.URL + "/test")
	if err != nil {
		t.Fatalf("Request through proxy failed: %v", err)
	}
	defer resp.Body.Close()

	// Verify headers were injected
	if got := receivedHeaders.Get("Authorization"); got != "Bearer test-token" {
		t.Errorf("Authorization header = %q, want %q", got, "Bearer test-token")
	}
	if got := receivedHeaders.Get("X-Custom"); got != "injected" {
		t.Errorf("X-Custom header = %q, want %q", got, "injected")
	}
}

func TestIntegration_HTTPProxy_HeaderAppend(t *testing.T) {
	// Create a test HTTP server that echoes headers
	var receivedHeaders http.Header
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeaders = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	// Create proxy with append rules
	inj := injector.New()
	inj.SetRules(config.HeadersConfig{
		"*": config.HeaderRule{
			Append: map[string]string{
				"X-Forwarded-For": "proxy.internal",
			},
		},
	})

	proxy := goproxy.NewProxyHttpServer()
	proxy.Verbose = false
	proxy.OnRequest().DoFunc(func(req *http.Request, _ *goproxy.ProxyCtx) (*http.Request, *http.Response) {
		inj.Apply(req)
		return req, nil
	})

	proxyServer := httptest.NewServer(proxy)
	defer proxyServer.Close()

	// Create HTTP client that uses the proxy
	proxyURL, _ := url.Parse(proxyServer.URL)
	transport := &http.Transport{
		Proxy: http.ProxyURL(proxyURL),
	}
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}

	// Make request through proxy
	resp, err := client.Get(backend.URL + "/test")
	if err != nil {
		t.Fatalf("Request through proxy failed: %v", err)
	}
	defer resp.Body.Close()

	// Verify header contains appended value
	got := receivedHeaders.Get("X-Forwarded-For")
	if !strings.Contains(got, "proxy.internal") {
		t.Errorf("X-Forwarded-For header = %q, should contain 'proxy.internal'", got)
	}
}

func TestIntegration_SOCKS5Proxy_TCP(t *testing.T) {
	// Create a simple TCP echo server
	echoListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Failed to create listener: %v", err)
	}
	defer echoListener.Close()

	echoAddr := echoListener.Addr().String()

	go func() {
		for {
			conn, err := echoListener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				io.Copy(c, c)
			}(conn)
		}
	}()

	// Start SOCKS5 proxy
	log := testLogger(t)
	flt := filter.New()
	socksProxy := NewSOCKSProxy(flt, log)

	socksListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Failed to create SOCKS listener: %v", err)
	}
	defer socksListener.Close()

	proxyAddr := socksListener.Addr().String()

	go func() {
		for {
			conn, err := socksListener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				socksProxy.ServeConn(c)
			}(conn)
		}
	}()

	// Connect to proxy via SOCKS5
	conn, err := net.DialTimeout("tcp", proxyAddr, 5*time.Second)
	if err != nil {
		t.Fatalf("Failed to connect to proxy: %v", err)
	}
	defer conn.Close()

	// SOCKS5 handshake
	_, err = conn.Write([]byte{0x05, 0x01, 0x00})
	if err != nil {
		t.Fatalf("Failed to send SOCKS5 greeting: %v", err)
	}

	// Read response
	resp := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, err = io.ReadFull(conn, resp)
	if err != nil {
		t.Fatalf("Failed to read SOCKS5 response: %v", err)
	}
	if resp[0] != 0x05 || resp[1] != 0x00 {
		t.Fatalf("Unexpected SOCKS5 response: %v", resp)
	}

	// Send connect request
	host, portStr, _ := net.SplitHostPort(echoAddr)
	port := 0
	fmt.Sscanf(portStr, "%d", &port)

	connectReq := buildSOCKS5ConnectRequest(host, port)

	_, err = conn.Write(connectReq)
	if err != nil {
		t.Fatalf("Failed to send connect request: %v", err)
	}

	// Read connect response
	respHeader := make([]byte, 10)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, err = io.ReadFull(conn, respHeader)
	if err != nil {
		t.Fatalf("Failed to read connect response: %v", err)
	}
	if respHeader[1] != 0x00 {
		t.Fatalf("SOCKS5 connect failed with status: %d", respHeader[1])
	}

	// Test echo
	testData := "Hello through SOCKS5!"
	_, err = conn.Write([]byte(testData))
	if err != nil {
		t.Fatalf("Failed to write test data: %v", err)
	}

	echoBuf := make([]byte, len(testData))
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, err = io.ReadFull(conn, echoBuf)
	if err != nil {
		t.Fatalf("Failed to read echo response: %v", err)
	}

	if string(echoBuf) != testData {
		t.Errorf("Echo response = %q, want %q", echoBuf, testData)
	}
}

func TestIntegration_SOCKS5Proxy_Filter(t *testing.T) {
	// Start SOCKS5 proxy with filter
	log := testLogger(t)
	flt := filter.New()
	flt.SetEnabled(true)
	flt.SetAllowlist([]string{"allowed.example.com"}, nil)
	socksProxy := NewSOCKSProxy(flt, log)

	socksListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Failed to create SOCKS listener: %v", err)
	}
	defer socksListener.Close()

	proxyAddr := socksListener.Addr().String()

	go func() {
		for {
			conn, err := socksListener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				socksProxy.ServeConn(c)
			}(conn)
		}
	}()

	// Connect via SOCKS5
	conn, err := net.DialTimeout("tcp", proxyAddr, 5*time.Second)
	if err != nil {
		t.Fatalf("Failed to connect to proxy: %v", err)
	}
	defer conn.Close()

	// SOCKS5 handshake
	conn.Write([]byte{0x05, 0x01, 0x00})
	resp := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	io.ReadFull(conn, resp)

	// Try blocked domain
	blockedHost := "blocked.example.com"
	connectReq := buildSOCKS5ConnectRequest(blockedHost, 80)

	conn.Write(connectReq)

	// Read response - should fail
	respHeader := make([]byte, 4)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err = io.ReadFull(conn, respHeader)
	if err != nil {
		// Connection closed is acceptable
		return
	}

	if respHeader[1] == 0x00 {
		t.Error("Expected SOCKS5 connect to fail for blocked domain")
	}
}

func TestIntegration_ProtocolDetection_SOCKS5(t *testing.T) {
	// Start multi-protocol server
	log := testLogger(t)
	flt := filter.New()
	socksProxy := NewSOCKSProxy(flt, log)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Failed to create listener: %v", err)
	}
	defer listener.Close()

	proxyAddr := listener.Addr().String()

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()

				proto, peeked, err := Detect(c)
				if err != nil {
					return
				}

				if proto == ProtocolSOCKS5 {
					socksProxy.ServeConn(peeked)
				}
			}(conn)
		}
	}()

	// Connect and send SOCKS5 greeting
	conn, err := net.DialTimeout("tcp", proxyAddr, 5*time.Second)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer conn.Close()

	// Send SOCKS5 greeting
	conn.Write([]byte{0x05, 0x01, 0x00})

	// Read response
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	resp := make([]byte, 2)
	_, err = io.ReadFull(conn, resp)
	if err != nil {
		t.Fatalf("Failed to read SOCKS5 response: %v", err)
	}

	if resp[0] != 0x05 {
		t.Errorf("Expected SOCKS5 version (0x05), got 0x%02x", resp[0])
	}
}

// TestIntegration_SSHOverSOCKS5 tests tunneling SSH-like traffic through SOCKS5
func TestIntegration_SSHOverSOCKS5(t *testing.T) {
	// Create mock SSH server
	sshListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Failed to create listener: %v", err)
	}
	defer sshListener.Close()

	sshAddr := sshListener.Addr().String()

	go func() {
		for {
			conn, err := sshListener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				c.Write([]byte("SSH-2.0-TestServer\r\n"))
				io.Copy(c, c)
			}(conn)
		}
	}()

	// Start SOCKS5 proxy
	log := testLogger(t)
	flt := filter.New()
	socksProxy := NewSOCKSProxy(flt, log)

	socksListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Failed to create SOCKS listener: %v", err)
	}
	defer socksListener.Close()

	proxyAddr := socksListener.Addr().String()

	go func() {
		for {
			conn, err := socksListener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				socksProxy.ServeConn(c)
			}(conn)
		}
	}()

	// Connect via SOCKS5
	conn, err := net.DialTimeout("tcp", proxyAddr, 5*time.Second)
	if err != nil {
		t.Fatalf("Failed to connect to proxy: %v", err)
	}
	defer conn.Close()

	// SOCKS5 handshake
	conn.Write([]byte{0x05, 0x01, 0x00})
	resp := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	io.ReadFull(conn, resp)

	// Connect to SSH server
	host, portStr, _ := net.SplitHostPort(sshAddr)
	port := 0
	fmt.Sscanf(portStr, "%d", &port)

	connectReq := buildSOCKS5ConnectRequest(host, port)
	conn.Write(connectReq)

	// Read SOCKS5 response
	respBuf := make([]byte, 10)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := io.ReadFull(conn, respBuf)
	if err != nil || n < 4 || respBuf[1] != 0x00 {
		t.Fatalf("SOCKS5 connect failed")
	}

	// Read SSH banner
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	bannerBuf := make([]byte, 100)
	n, err = conn.Read(bannerBuf)
	if err != nil {
		t.Fatalf("Failed to read SSH banner: %v", err)
	}

	banner := string(bannerBuf[:n])
	if !strings.HasPrefix(banner, "SSH-2.0") {
		t.Errorf("Expected SSH banner, got: %q", banner)
	}
}

// TestIntegration_MySQLOverSOCKS5 tests tunneling MySQL-like traffic through SOCKS5
func TestIntegration_MySQLOverSOCKS5(t *testing.T) {
	// Create mock MySQL server
	mysqlListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Failed to create listener: %v", err)
	}
	defer mysqlListener.Close()

	mysqlAddr := mysqlListener.Addr().String()

	go func() {
		for {
			conn, err := mysqlListener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				// MySQL handshake packet
				handshake := []byte{
					0x4a, 0x00, 0x00, 0x00,
					0x0a,
					0x38, 0x2e, 0x30, 0x2e, 0x32, 0x38, 0x00,
					0x01, 0x00, 0x00, 0x00,
					0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
				}
				c.Write(handshake)
				buf := make([]byte, 1024)
				c.Read(buf)
			}(conn)
		}
	}()

	// Start SOCKS5 proxy
	log := testLogger(t)
	flt := filter.New()
	socksProxy := NewSOCKSProxy(flt, log)

	socksListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Failed to create SOCKS listener: %v", err)
	}
	defer socksListener.Close()

	proxyAddr := socksListener.Addr().String()

	go func() {
		for {
			conn, err := socksListener.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				socksProxy.ServeConn(c)
			}(conn)
		}
	}()

	// Connect via SOCKS5
	conn, err := net.DialTimeout("tcp", proxyAddr, 5*time.Second)
	if err != nil {
		t.Fatalf("Failed to connect to proxy: %v", err)
	}
	defer conn.Close()

	// SOCKS5 handshake
	conn.Write([]byte{0x05, 0x01, 0x00})
	resp := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	io.ReadFull(conn, resp)

	// Connect to MySQL server
	host, portStr, _ := net.SplitHostPort(mysqlAddr)
	port := 0
	fmt.Sscanf(portStr, "%d", &port)

	connectReq := buildSOCKS5ConnectRequest(host, port)
	conn.Write(connectReq)

	// Read SOCKS5 response
	respBuf := make([]byte, 10)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, _ := conn.Read(respBuf)
	if n < 4 || respBuf[1] != 0x00 {
		t.Fatalf("SOCKS5 connect failed")
	}

	// Read MySQL handshake
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	mysqlBuf := make([]byte, 100)
	n, err = conn.Read(mysqlBuf)
	if err != nil {
		t.Fatalf("Failed to read MySQL handshake: %v", err)
	}

	// Check MySQL protocol version
	if n > 4 && mysqlBuf[4] != 0x0a {
		t.Errorf("Expected MySQL protocol version 10, got: %d", mysqlBuf[4])
	}
}
