# Proxy Architecture

This document describes the architecture of the Discobot Proxy, a multi-protocol proxy server with HTTP interception and header injection capabilities.

## Overview

The proxy follows a layered architecture with protocol detection at the entry point:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Listener (:8080)                             │
│                    Protocol Detection Layer                          │
└─────────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┴───────────────────┐
          │                                       │
          ▼                                       ▼
┌─────────────────────┐               ┌─────────────────────┐
│    HTTP Proxy       │               │    SOCKS5 Proxy     │
│    (goproxy)        │               │    (go-socks5)      │
└─────────────────────┘               └─────────────────────┘
          │                                       │
          ▼                                       ▼
┌─────────────────────┐               ┌─────────────────────┐
│  Header Injection   │               │  Connection Filter  │
│  Request Logging    │               │  Request Logging    │
└─────────────────────┘               └─────────────────────┘
```

## Module Documentation

- [Config Module](./design/config.md) - Configuration and file watching
- [Proxy Module](./design/proxy.md) - HTTP and SOCKS5 proxy implementation
- [Injector Module](./design/injector.md) - Header injection logic
- [API Module](./design/api.md) - REST API for configuration

## Directory Structure

```
proxy/
├── cmd/proxy/main.go           # Entry point
├── internal/
│   ├── config/
│   │   ├── config.go           # Config types, loading, validation
│   │   └── watcher.go          # fsnotify file watcher
│   ├── proxy/
│   │   ├── server.go           # Main server, lifecycle management
│   │   ├── http.go             # goproxy setup and handlers
│   │   ├── socks.go            # go-socks5 setup and rules
│   │   └── detector.go         # First-byte protocol detection
│   ├── injector/
│   │   ├── injector.go         # Thread-safe header storage
│   │   └── matcher.go          # Glob-style domain matching
│   ├── cert/
│   │   └── manager.go          # CA generation, storage, caching
│   ├── api/
│   │   ├── server.go           # chi router setup
│   │   └── handlers.go         # POST handlers for config
│   ├── logger/
│   │   └── logger.go           # zap-based structured logging
│   └── filter/
│       └── filter.go           # DNS/IP allowlist with CIDR
```

## Design Decisions

### 1. Single Port with Protocol Detection

The proxy runs on a single port (default 8080) and uses first-byte sniffing to detect the protocol:

```go
func DetectProtocol(conn net.Conn) (Protocol, []byte, error) {
    buf := make([]byte, 1)
    _, err := io.ReadFull(conn, buf)
    if err != nil {
        return Unknown, nil, err
    }

    switch buf[0] {
    case 0x05:
        return SOCKS5, buf, nil
    case 0x04:
        return SOCKS4, buf, nil  // Unsupported, will reject
    default:
        // ASCII printable characters indicate HTTP
        if buf[0] >= 0x20 && buf[0] <= 0x7E {
            return HTTP, buf, nil
        }
        return Unknown, buf, nil
    }
}
```

**Rationale**: Simpler configuration for users (one port, one env var). The protocols have non-overlapping signatures making detection reliable.

### 2. goproxy for HTTP/HTTPS

We use `elazarl/goproxy` for HTTP proxying because it:
- Has built-in MITM support with certificate generation
- Provides clean request/response handler APIs
- Is battle-tested (2.1k+ stars, widely used)
- Supports both HTTP and HTTPS CONNECT tunneling

```go
proxy := goproxy.NewProxyHttpServer()
proxy.OnRequest().HandleConnect(goproxy.AlwaysMitm)
proxy.OnRequest().DoFunc(func(req *http.Request, ctx *goproxy.ProxyCtx) (*http.Request, *http.Response) {
    // Inject headers based on domain
    injector.Apply(req)
    logger.LogRequest(req)
    return req, nil
})
```

### 3. things-go/go-socks5 for SOCKS5

We use `things-go/go-socks5` because it:
- Is actively maintained (2025)
- Provides middleware and custom dialer hooks
- Has rule-based filtering built-in
- Supports disabling UDP (we only want TCP)

```go
server := socks5.NewServer(
    socks5.WithRule(&AllowlistRule{filter: filter}),
    socks5.WithDial(customDialer),
    socks5.WithLogger(logger),
)
```

### 4. Header Injection Design

Headers are stored in a thread-safe map with domain pattern matching:

```go
type Injector struct {
    mu      sync.RWMutex
    rules   map[string]map[string]string  // domain -> headers
}

func (i *Injector) Apply(req *http.Request) {
    i.mu.RLock()
    defer i.mu.RUnlock()

    for pattern, headers := range i.rules {
        if matchDomain(pattern, req.Host) {
            for key, value := range headers {
                req.Header.Set(key, expandEnv(value))
            }
            return  // First match wins
        }
    }
}
```

Domain patterns support:
- Exact match: `api.anthropic.com`
- Wildcard prefix: `*.github.com` (matches `api.github.com`, `raw.github.com`)
- Wildcard suffix: `api.*` (matches `api.com`, `api.io`)

Note: No environment variable expansion is performed. Set secrets directly via the REST API at runtime.

### 5. Configuration Hot Reload

The config file is watched using `fsnotify`:

```go
func (w *Watcher) Start(callback func(*Config)) error {
    watcher, _ := fsnotify.NewWatcher()
    watcher.Add(w.configPath)

    for {
        select {
        case event := <-watcher.Events:
            if event.Op&fsnotify.Write == fsnotify.Write {
                cfg, err := Load(w.configPath)
                if err == nil {
                    callback(cfg)
                }
            }
        case <-w.stop:
            return nil
        }
    }
}
```

Changes are applied atomically to the injector and filter without restarting the proxy.

### 6. REST API (Single Document Model)

The API uses a single-document model for simplicity:
- **POST /api/config** - Complete overwrite of running config
- **PATCH /api/config** - Merge partial config into running config
- **No GET** - prevents credential leakage

```go
r := chi.NewRouter()
r.Post("/api/config", h.handleSetConfig)   // Overwrite
r.Patch("/api/config", h.handlePatchConfig) // Merge
r.Get("/health", h.handleHealth)
```

PATCH merge behavior:
- `headers`: Each domain key merges; `null` value deletes domain
- `allowlist.domains/ips`: Values are added to existing lists
- `allowlist.enabled`: Overwrites current value

### 7. Certificate Management

On first run, a CA certificate is generated and saved:

```go
func (m *Manager) GetOrCreateCA() (*tls.Certificate, error) {
    certPath := filepath.Join(m.certDir, "ca.crt")
    keyPath := filepath.Join(m.certDir, "ca.key")

    // Try to load existing
    if cert, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
        return &cert, nil
    }

    // Generate new CA
    ca, err := m.generateCA()
    if err != nil {
        return nil, err
    }

    // Save to disk
    m.saveCert(certPath, ca.Certificate)
    m.saveKey(keyPath, ca.PrivateKey)

    return ca, nil
}
```

The CA is used by goproxy to sign certificates for intercepted HTTPS connections.

## Request Flow

### HTTP Request Flow

```
Client
   │
   │ GET http://example.com/path
   ▼
┌─────────────────┐
│ Protocol Detect │ → Detects "GET" (ASCII) → HTTP
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ goproxy Handler │
├─────────────────┤
│ 1. Filter check │ → Is example.com allowed?
│ 2. Header inject│ → Apply matching rules
│ 3. Log request  │ → Structured logging
│ 4. Forward req  │ → To origin server
│ 5. Log response │
│ 6. Return resp  │ → To client
└─────────────────┘
```

### HTTPS Request Flow (MITM)

```
Client
   │
   │ CONNECT api.anthropic.com:443
   ▼
┌─────────────────┐
│ Protocol Detect │ → Detects "CONNECT" (ASCII) → HTTP
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ goproxy CONNECT │
├─────────────────┤
│ 1. Filter check │ → Is api.anthropic.com allowed?
│ 2. MITM setup   │ → Generate cert for domain
│ 3. TLS handshake│ → Client ↔ Proxy (using generated cert)
│ 4. TLS handshake│ → Proxy ↔ Server (real cert)
└────────┬────────┘
         │
         │ (Now proxy can see plaintext HTTP)
         ▼
┌─────────────────┐
│ Request Handler │
├─────────────────┤
│ 1. Header inject│ → Apply matching rules
│ 2. Log request  │
│ 3. Forward      │
│ 4. Log response │
└─────────────────┘
```

### SOCKS5 Request Flow

```
Client
   │
   │ 0x05 0x01 0x00 (SOCKS5 handshake)
   ▼
┌─────────────────┐
│ Protocol Detect │ → Detects 0x05 → SOCKS5
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ go-socks5       │
├─────────────────┤
│ 1. Auth (none)  │ → No auth required
│ 2. CONNECT req  │ → Dest: github.com:22
│ 3. Rule check   │ → Is github.com allowed?
│ 4. Dial target  │ → TCP connect to github.com:22
│ 5. Log connect  │ → Log destination only
│ 6. Tunnel data  │ → Bidirectional pipe
└─────────────────┘
         │
         │ (SSH traffic flows through, encrypted end-to-end)
         ▼
      SSH Server
```

## Configuration Schema

```yaml
# Full configuration schema
proxy:
  port: 8080              # Main proxy port
  api_port: 8081          # REST API port
  read_timeout: 30s       # Connection read timeout
  write_timeout: 30s      # Connection write timeout

tls:
  cert_dir: ./certs       # CA certificate directory
  # CA cert auto-generated if not exists

allowlist:
  enabled: true           # Enable filtering (false = allow all)
  domains:                # Domain patterns
    - "*.github.com"
    - "api.anthropic.com"
    - "*.openai.com"
  ips:                    # CIDR ranges
    - "10.0.0.0/8"
    - "192.168.0.0/16"

headers:                  # Domain -> header rules (set secrets via API)
  "api.anthropic.com":
    set:                  # Replace header value
      "X-Custom-Header": "value"
  "*.openai.com":
    set:
      "X-Request-Source": "proxy"
    append:               # Append to existing value with ", "
      "X-Forwarded-For": "proxy.internal"

logging:
  level: info             # debug, info, warn, error
  format: text            # text, json
  file: ""                # Path or empty for stdout
  include_body: false     # Log request/response bodies
```

## Thread Safety

All shared state is protected:

| Component | Protection | Access Pattern |
|-----------|------------|----------------|
| `Injector.rules` | `sync.RWMutex` | Read-heavy (per request) |
| `Filter.allowlist` | `sync.RWMutex` | Read-heavy (per request) |
| `Config` | Atomic swap | Write on reload only |
| `Logger` | Thread-safe (zap) | Write-heavy |

## Error Handling

### Proxy Errors

```go
// Connection errors - log and close
if err != nil {
    logger.Error("connection error", zap.Error(err))
    conn.Close()
    return
}

// Filter rejection - return appropriate error
if !filter.Allow(host) {
    // HTTP: return 403 Forbidden
    // SOCKS5: return connection refused
}
```

### Config Errors

```go
// Config parse error - keep old config, log warning
cfg, err := Load(path)
if err != nil {
    logger.Warn("config reload failed, keeping previous",
        zap.Error(err))
    return
}
// Atomically swap to new config
```

## Metrics (Future)

Planned metrics to expose:

| Metric | Type | Description |
|--------|------|-------------|
| `proxy_requests_total` | Counter | Total requests by protocol |
| `proxy_request_duration_seconds` | Histogram | Request latency |
| `proxy_active_connections` | Gauge | Current connections |
| `proxy_bytes_transferred_total` | Counter | Bytes in/out |
| `proxy_filter_rejections_total` | Counter | Blocked requests |
