# Implementation Plan

This document outlines the step-by-step implementation plan for the Discobot Proxy.

## Overview

The proxy will be implemented in phases, with each phase building on the previous one. The goal is to have a working proxy at each phase that can be tested independently.

## Phase 1: Project Setup and Core Infrastructure

### 1.1 Initialize Go Module

```bash
cd proxy
go mod init github.com/darren/discobot/proxy
```

**Files:**
- `go.mod`
- `go.sum`

### 1.2 Configuration Module

Implement configuration loading and validation.

**Files:**
- `internal/config/config.go` - Config types, Load(), Validate(), DefaultConfig()

**Tests:**
- Load valid YAML
- Validation errors for invalid config
- Environment variable expansion

### 1.3 Logging Module

Set up structured logging with zap.

**Files:**
- `internal/logger/logger.go` - Logger wrapper, request/response logging

**Features:**
- Configurable log level
- JSON or text format
- Request logging with timing

---

## Phase 2: Certificate Management

### 2.1 CA Certificate Generation

Generate and store CA certificate for MITM.

**Files:**
- `internal/cert/manager.go` - GetOrCreateCA(), generateCA(), loadCA()

**Features:**
- Generate RSA 2048-bit CA on first run
- Save to disk (ca.crt, ca.key)
- Load existing CA on subsequent runs
- 10-year validity

**Tests:**
- Generate new CA
- Load existing CA
- Certificate validity

---

## Phase 3: Header Injection

### 3.1 Domain Matcher

Implement glob-style domain pattern matching.

**Files:**
- `internal/injector/matcher.go` - matchDomain(), isValidDomainPattern()

**Tests:**
- Exact match
- Wildcard prefix (*.example.com)
- Wildcard suffix (api.*)
- Invalid patterns rejected

### 3.2 Injector

Thread-safe header storage and application.

**Files:**
- `internal/injector/injector.go` - Injector struct, SetRules(), Apply()

**Tests:**
- Set and apply headers
- Concurrent access safety
- Environment variable expansion
- Pattern priority

---

## Phase 4: Connection Filtering

### 4.1 Allowlist Filter

DNS and IP-based allowlist filtering.

**Files:**
- `internal/filter/filter.go` - Filter struct, AllowHost(), AllowIP()

**Features:**
- Domain pattern matching (reuse matcher)
- CIDR range support
- Enable/disable toggle
- Thread-safe updates

**Tests:**
- Domain allowlist
- IP/CIDR allowlist
- Disabled filter allows all

---

## Phase 5: HTTP Proxy

### 5.1 HTTP Proxy Setup

Set up goproxy with MITM and handlers.

**Files:**
- `internal/proxy/http.go` - setupHTTPProxy(), request/response handlers

**Features:**
- MITM for HTTPS using generated CA
- Filter integration (reject blocked hosts)
- Injector integration (apply headers)
- Request/response logging

**Tests:**
- HTTP proxy works
- HTTPS MITM works
- Headers injected correctly
- Blocked hosts rejected

---

## Phase 6: SOCKS5 Proxy

### 6.1 SOCKS5 Setup

Set up go-socks5 with filtering.

**Files:**
- `internal/proxy/socks.go` - setupSOCKSProxy(), filterRule

**Features:**
- No authentication (can add later)
- Rule-based filtering (integrate with Filter)
- Connection logging

**Tests:**
- SOCKS5 connection works
- Blocked hosts rejected
- Logging works

---

## Phase 7: Protocol Detection

### 7.1 Detector

First-byte protocol detection.

**Files:**
- `internal/proxy/detector.go` - Detect(), PeekedConn

**Features:**
- Detect HTTP vs SOCKS5
- Wrap connection to replay peeked bytes

**Tests:**
- Detect HTTP (ASCII start)
- Detect SOCKS5 (0x05 start)
- Unknown protocol handled

---

## Phase 8: Main Server

### 8.1 Server Integration

Combine all components into main server.

**Files:**
- `internal/proxy/server.go` - Server struct, ListenAndServe(), handleConnection()

**Features:**
- Single port listener
- Protocol detection dispatch
- Graceful shutdown

### 8.2 Entry Point

Main function with startup logic.

**Files:**
- `cmd/proxy/main.go` - main(), signal handling, config loading

**Features:**
- Load config file
- Initialize all components
- Start proxy and API servers
- Handle SIGINT/SIGTERM

---

## Phase 9: REST API

### 9.1 API Server

HTTP server for configuration with single-document model.

**Files:**
- `internal/api/server.go` - Server struct, setupRoutes()
- `internal/api/handlers.go` - Handler functions

**Features:**
- POST /api/config - Overwrite entire config
- PATCH /api/config - Merge partial config
- GET /health

**Tests:**
- POST overwrites completely
- PATCH merges correctly
- PATCH with null deletes domain
- Validation errors returned
- Changes take effect immediately

---

## Phase 10: Config File Watching

### 10.1 File Watcher

Hot reload configuration on file change.

**Files:**
- `internal/config/watcher.go` - Watcher struct, Start(), loop()

**Features:**
- fsnotify-based watching
- Debounce rapid changes
- Apply changes atomically

**Tests:**
- Config reload on change
- Invalid config keeps old
- Debouncing works

---

## Phase 11: Integration and Polish

### 11.1 Unit Tests

**Files:**
- `internal/injector/injector_test.go`
- `internal/injector/matcher_test.go`
- `internal/filter/filter_test.go`
- `internal/config/config_test.go`
- `internal/proxy/detector_test.go`

**Test Coverage:**
- Domain pattern matching (exact, wildcard prefix/suffix)
- Header injection application
- IP/CIDR filtering
- Config validation
- Protocol detection (HTTP vs SOCKS5 first bytes)

### 11.2 Integration Tests - HTTP Proxy

**Files:**
- `internal/integration/http_test.go`

**HTTP/1.1 Tests:**
```go
func TestHTTP1_PlainText(t *testing.T)           // GET http://httpbin.org/get
func TestHTTP1_PlainText_POST(t *testing.T)      // POST with body
func TestHTTP1_TLS(t *testing.T)                 // GET https://httpbin.org/get (MITM)
func TestHTTP1_TLS_POST(t *testing.T)            // POST over TLS
func TestHTTP1_HeaderInjection(t *testing.T)     // Verify injected headers
func TestHTTP1_HeaderInjection_TLS(t *testing.T) // Verify over MITM
func TestHTTP1_Blocked(t *testing.T)             // Filter rejects request
func TestHTTP1_LargeBody(t *testing.T)           // Large request/response
func TestHTTP1_Chunked(t *testing.T)             // Chunked transfer encoding
```

**HTTP/2 Tests:**
```go
func TestHTTP2_TLS(t *testing.T)                 // HTTP/2 over TLS (ALPN)
func TestHTTP2_HeaderInjection(t *testing.T)     // Verify headers in HTTP/2
func TestHTTP2_Multiplexed(t *testing.T)         // Multiple concurrent streams
func TestHTTP2_ServerPush(t *testing.T)          // Handle server push (if applicable)
func TestHTTP2_PriorKnowledge(t *testing.T)      // HTTP/2 without TLS (h2c)
```

### 11.3 Integration Tests - SOCKS5 Proxy

**Files:**
- `internal/integration/socks_test.go`

**SOCKS5 + HTTP Tests:**
```go
func TestSOCKS5_HTTP1_PlainText(t *testing.T)    // HTTP/1.1 through SOCKS
func TestSOCKS5_HTTP1_TLS(t *testing.T)          // HTTPS through SOCKS (passthrough)
func TestSOCKS5_HTTP2_TLS(t *testing.T)          // HTTP/2 through SOCKS
func TestSOCKS5_Blocked(t *testing.T)            // Filter rejects SOCKS connect
```

**SOCKS5 + SSH Tests:**
```go
func TestSOCKS5_SSH_Connect(t *testing.T)        // SSH connection through SOCKS
func TestSOCKS5_SSH_Auth(t *testing.T)           // SSH with password auth
func TestSOCKS5_SSH_KeyAuth(t *testing.T)        // SSH with key auth
func TestSOCKS5_SSH_Exec(t *testing.T)           // Execute command over SSH
func TestSOCKS5_SSH_Tunnel(t *testing.T)         // SSH port forwarding through SOCKS
```

**SOCKS5 + MySQL Tests:**
```go
func TestSOCKS5_MySQL_PlainText(t *testing.T)    // MySQL without TLS
func TestSOCKS5_MySQL_TLS(t *testing.T)          // MySQL with TLS
func TestSOCKS5_MySQL_Query(t *testing.T)        // Execute query through proxy
func TestSOCKS5_MySQL_LargeResult(t *testing.T)  // Large result set
```

### 11.4 Integration Tests - API

**Files:**
- `internal/integration/api_test.go`

```go
func TestAPI_PostConfig_Overwrite(t *testing.T)
func TestAPI_PatchConfig_Merge(t *testing.T)
func TestAPI_PatchConfig_DeleteDomain(t *testing.T)
func TestAPI_PostConfig_Invalid(t *testing.T)
func TestAPI_ConfigTakesEffect(t *testing.T)     // Verify proxy uses new config
func TestAPI_Health(t *testing.T)
```

### 11.5 Integration Tests - Config Reload

**Files:**
- `internal/integration/config_test.go`

```go
func TestConfigReload_HeadersUpdated(t *testing.T)
func TestConfigReload_AllowlistUpdated(t *testing.T)
func TestConfigReload_InvalidConfigIgnored(t *testing.T)
```

### 11.6 Protocol Detection Tests

**Files:**
- `internal/integration/detection_test.go`

```go
func TestDetection_HTTP_GET(t *testing.T)        // Detects "GET " as HTTP
func TestDetection_HTTP_POST(t *testing.T)       // Detects "POST " as HTTP
func TestDetection_HTTP_CONNECT(t *testing.T)    // Detects "CONNECT " as HTTP
func TestDetection_SOCKS5(t *testing.T)          // Detects 0x05 as SOCKS5
func TestDetection_SOCKS4_Rejected(t *testing.T) // Rejects 0x04 (SOCKS4)
func TestDetection_Unknown(t *testing.T)         // Handles unknown protocol
func TestDetection_SlowClient(t *testing.T)      // Timeout on no data
```

### 11.7 Test Infrastructure

**Files:**
- `internal/integration/testutil/server.go` - Test server helpers
- `internal/integration/testutil/client.go` - Test client helpers

**Test Helpers:**
```go
// StartTestProxy starts proxy on random port, returns cleanup func
func StartTestProxy(t *testing.T, cfg *config.Config) (*Server, func())

// StartHTTPServer starts httpbin-like test server
func StartHTTPServer(t *testing.T) (addr string, cleanup func())

// StartTLSServer starts HTTPS test server
func StartTLSServer(t *testing.T) (addr string, cleanup func())

// StartSSHServer starts SSH test server (using gliderlabs/ssh)
func StartSSHServer(t *testing.T) (addr string, cleanup func())

// StartMySQLServer starts MySQL test server (using go-mysql-server)
func StartMySQLServer(t *testing.T) (addr string, cleanup func())

// HTTPClientViaProxy creates http.Client configured for proxy
func HTTPClientViaProxy(proxyAddr string, useTLS bool) *http.Client

// SOCKS5Dialer creates dialer through SOCKS5 proxy
func SOCKS5Dialer(proxyAddr string) proxy.Dialer
```

### 11.8 Test Dependencies

Add to `go.mod` for testing:
```go
require (
    github.com/gliderlabs/ssh v0.3.5        // SSH test server
    github.com/dolthub/go-mysql-server v0.17.0  // MySQL test server
    github.com/stretchr/testify v1.8.4      // Assertions
    golang.org/x/net v0.20.0                // proxy.SOCKS5
)
```

### 11.9 Documentation Review

- Ensure README.md matches implementation
- Verify config.example.yaml covers all options

---

## Dependency Summary

```go
require (
    // Core dependencies
    github.com/elazarl/goproxy v0.0.0-latest
    github.com/things-go/go-socks5 v0.0.5
    github.com/fsnotify/fsnotify v1.7.0
    github.com/go-chi/chi/v5 v5.0.12
    go.uber.org/zap v1.27.0
    gopkg.in/yaml.v3 v3.0.1

    // Test dependencies
    github.com/stretchr/testify v1.8.4
    github.com/gliderlabs/ssh v0.3.5           // SSH test server
    github.com/dolthub/go-mysql-server v0.17.0 // MySQL test server
    golang.org/x/net v0.20.0                   // proxy.SOCKS5 dialer
    golang.org/x/crypto v0.18.0                // SSH client for tests
)
```

---

## Implementation Order

| Phase | Component | Est. Complexity | Dependencies |
|-------|-----------|-----------------|--------------|
| 1.1 | Go module init | Low | None |
| 1.2 | Config module | Medium | 1.1 |
| 1.3 | Logger module | Low | 1.1 |
| 2.1 | Cert manager | Medium | 1.1 |
| 3.1 | Domain matcher | Low | 1.1 |
| 3.2 | Injector | Medium | 3.1 |
| 4.1 | Filter | Medium | 3.1 |
| 5.1 | HTTP proxy | High | 1.2, 1.3, 2.1, 3.2, 4.1 |
| 6.1 | SOCKS5 proxy | Medium | 1.3, 4.1 |
| 7.1 | Protocol detector | Low | None |
| 8.1 | Server integration | Medium | 5.1, 6.1, 7.1 |
| 8.2 | Entry point | Low | 8.1 |
| 9.1 | REST API | Medium | 3.2, 4.1 |
| 10.1 | File watcher | Medium | 1.2 |
| 11.x | Integration/polish | Medium | All |

---

## Milestones

### Milestone 1: Basic HTTP Proxy
- Phases 1-5 complete
- HTTP/HTTPS proxy working
- Header injection working
- Manual testing possible

### Milestone 2: Multi-Protocol Proxy
- Phase 6-8 complete
- SOCKS5 working
- Protocol detection working
- Single port operation

### Milestone 3: Dynamic Configuration
- Phase 9-10 complete
- REST API working
- Config hot reload working

### Milestone 4: Production Ready
- Phase 11 complete
- Integration tests passing
- Documentation complete

---

## Testing Strategy

### Unit Tests
- Each module has `_test.go` files
- Mock dependencies where needed
- Table-driven tests for pattern matching

### Integration Tests
- Use `httptest` for HTTP testing
- Spin up real proxy for e2e tests
- Test with actual curl commands

### Manual Testing

```bash
# Start proxy
go run cmd/proxy/main.go

#
# HTTP/1.1 Tests
#

# HTTP/1.1 plaintext
curl --proxy http://localhost:8080 http://httpbin.org/get

# HTTP/1.1 over TLS (MITM)
curl --proxy http://localhost:8080 --cacert ./certs/ca.crt https://httpbin.org/get

# Header injection test (set)
curl -X PATCH http://localhost:8081/api/config \
  -d '{"headers": {"httpbin.org": {"set": {"X-Test": "injected"}}}}'
curl --proxy http://localhost:8080 http://httpbin.org/headers
# Should show X-Test: injected

# Header injection test (append)
curl -X PATCH http://localhost:8081/api/config \
  -d '{"headers": {"httpbin.org": {"append": {"X-Forwarded-For": "proxy"}}}}'
curl --proxy http://localhost:8080 http://httpbin.org/headers
# Should show X-Forwarded-For with "proxy" appended

#
# HTTP/2 Tests
#

# HTTP/2 over TLS (requires curl with HTTP/2 support)
curl --proxy http://localhost:8080 --cacert ./certs/ca.crt \
  --http2 https://httpbin.org/get

# Verify HTTP/2 is used
curl --proxy http://localhost:8080 --cacert ./certs/ca.crt \
  --http2 -w '%{http_version}\n' -o /dev/null -s https://nghttp2.org/

#
# SOCKS5 Tests
#

# SOCKS5 + HTTP
curl --socks5 localhost:8080 http://httpbin.org/get

# SOCKS5 + HTTPS (passthrough, no MITM)
curl --socks5 localhost:8080 https://httpbin.org/get

# SOCKS5 + SSH
ssh -o ProxyCommand='nc -x localhost:8080 %h %p' user@example.com

# Or using ncat
ssh -o ProxyCommand='ncat --proxy localhost:8080 --proxy-type socks5 %h %p' user@example.com

#
# MySQL Tests (via SOCKS5)
#

# MySQL through SOCKS5 (requires socat or proxychains)
# Option 1: Using proxychains
# Edit /etc/proxychains.conf: socks5 127.0.0.1 8080
proxychains mysql -h mysql.example.com -u user -p

# Option 2: Using socat to create local tunnel
socat TCP-LISTEN:13306,fork SOCKS4A:localhost:mysql.example.com:3306,socksport=8080 &
mysql -h 127.0.0.1 -P 13306 -u user -p

#
# Filter Tests
#

# Enable allowlist
curl -X PATCH http://localhost:8081/api/config \
  -d '{"allowlist": {"enabled": true, "domains": ["httpbin.org"]}}'

# This should work
curl --proxy http://localhost:8080 http://httpbin.org/get

# This should be blocked (403 for HTTP, connection refused for SOCKS)
curl --proxy http://localhost:8080 http://example.com
curl --socks5 localhost:8080 http://example.com
```
