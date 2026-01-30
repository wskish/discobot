# API Module

REST API for dynamic configuration with single-document updates.

## Files

| File | Purpose |
|------|---------|
| `internal/api/server.go` | HTTP server setup with chi router |
| `internal/api/handlers.go` | Request handlers |

## Design Principles

1. **Single document model** - One JSON blob represents the entire runtime config
2. **POST overwrites** - Complete replacement of running config
3. **PATCH merges** - Deep merge of partial config into running config
4. **No GET** - Cannot read config (may contain secrets)
5. **Immediate effect** - Changes apply to new requests immediately

## Server

```go
type Server struct {
    router   chi.Router
    injector *injector.Injector
    filter   *filter.Filter
    logger   *logger.Logger
    mu       sync.RWMutex
}

func New(inj *injector.Injector, flt *filter.Filter, log *logger.Logger) *Server {
    s := &Server{
        injector: inj,
        filter:   flt,
        logger:   log,
    }
    s.setupRoutes()
    return s
}

func (s *Server) setupRoutes() {
    r := chi.NewRouter()

    // Middleware
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(s.requestLogger)
    r.Use(middleware.Recoverer)

    // Health check
    r.Get("/health", s.handleHealth)

    // Configuration endpoint
    r.Post("/api/config", s.handleSetConfig)   // Overwrite
    r.Patch("/api/config", s.handlePatchConfig) // Merge

    s.router = r
}

func (s *Server) ListenAndServe(addr string) error {
    s.logger.Info("api server started", "addr", addr)
    return http.ListenAndServe(addr, s.router)
}
```

## Config Document Schema

The API accepts the same structure as the YAML config file, but in JSON:

```go
// RuntimeConfig is the JSON structure for API updates
type RuntimeConfig struct {
    Allowlist *AllowlistConfig `json:"allowlist,omitempty"`
    Headers   HeadersConfig    `json:"headers,omitempty"`
}

type AllowlistConfig struct {
    Enabled *bool    `json:"enabled,omitempty"`
    Domains []string `json:"domains,omitempty"`
    IPs     []string `json:"ips,omitempty"`
}

// HeadersConfig maps domain patterns to header rules
type HeadersConfig map[string]HeaderRule

// HeaderRule defines headers to set or append
type HeaderRule struct {
    Set    map[string]string `json:"set,omitempty"`    // Replace header value
    Append map[string]string `json:"append,omitempty"` // Append to existing value
}
```

## Handlers

```go
// POST /api/config - Complete overwrite
func (s *Server) handleSetConfig(w http.ResponseWriter, r *http.Request) {
    var cfg RuntimeConfig
    if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
        s.jsonError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
        return
    }

    if err := s.validateConfig(&cfg); err != nil {
        s.jsonError(w, err.Error(), http.StatusBadRequest)
        return
    }

    s.applyConfig(&cfg, false) // false = overwrite
    s.logger.Info("config replaced via API")

    s.jsonOK(w)
}

// PATCH /api/config - Merge with existing
func (s *Server) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
    var cfg RuntimeConfig
    if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
        s.jsonError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
        return
    }

    if err := s.validateConfig(&cfg); err != nil {
        s.jsonError(w, err.Error(), http.StatusBadRequest)
        return
    }

    s.applyConfig(&cfg, true) // true = merge
    s.logger.Info("config patched via API")

    s.jsonOK(w)
}

func (s *Server) validateConfig(cfg *RuntimeConfig) error {
    // Validate domain patterns in headers
    for domain := range cfg.Headers {
        if !isValidDomainPattern(domain) {
            return fmt.Errorf("invalid domain pattern: %s", domain)
        }
    }

    // Validate domain patterns in allowlist
    if cfg.Allowlist != nil {
        for _, domain := range cfg.Allowlist.Domains {
            if !isValidDomainPattern(domain) {
                return fmt.Errorf("invalid allowlist domain: %s", domain)
            }
        }
        // Validate IPs/CIDRs
        for _, ip := range cfg.Allowlist.IPs {
            if _, _, err := net.ParseCIDR(ip); err != nil {
                if net.ParseIP(ip) == nil {
                    return fmt.Errorf("invalid IP/CIDR: %s", ip)
                }
            }
        }
    }

    return nil
}

func (s *Server) applyConfig(cfg *RuntimeConfig, merge bool) {
    s.mu.Lock()
    defer s.mu.Unlock()

    if merge {
        // PATCH: merge into existing
        if cfg.Headers != nil {
            for domain, headers := range cfg.Headers {
                if headers == nil || len(headers) == 0 {
                    // Empty headers = delete this domain
                    s.injector.DeleteDomain(domain)
                } else {
                    s.injector.SetDomainHeaders(domain, headers)
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
        s.injector.SetRules(cfg.Headers)

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

// GET /health
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{
        "status": "ok",
    })
}

func (s *Server) jsonOK(w http.ResponseWriter) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (s *Server) jsonError(w http.ResponseWriter, message string, status int) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(map[string]string{"error": message})
}
```

## API Reference

### POST /api/config - Overwrite Config

Completely replaces the running configuration.

```bash
curl -X POST http://localhost:8081/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "allowlist": {
      "enabled": true,
      "domains": ["*.github.com", "api.anthropic.com"],
      "ips": ["10.0.0.0/8"]
    },
    "headers": {
      "api.anthropic.com": {
        "set": {
          "Authorization": "Bearer sk-ant-xxx",
          "X-Custom": "value"
        }
      },
      "*.github.com": {
        "set": {
          "Authorization": "token ghp_xxx"
        },
        "append": {
          "X-Forwarded-For": "proxy.internal"
        }
      }
    }
  }'
```

Response:
```json
{"status": "ok"}
```

### PATCH /api/config - Merge Config

Merges the provided config into the existing running config.

**Merge behavior:**
- `headers`: Each domain key is merged; set headers to `{}` or `null` to delete a domain
- `allowlist.domains`: Domains are added to existing list
- `allowlist.ips`: IPs are added to existing list
- `allowlist.enabled`: Overwrites the current value

```bash
# Add a new domain's headers (existing domains unchanged)
curl -X PATCH http://localhost:8081/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "api.openai.com": {
        "set": {
          "Authorization": "Bearer sk-xxx"
        }
      }
    }
  }'

# Add headers with append behavior
curl -X PATCH http://localhost:8081/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "*.example.com": {
        "append": {
          "X-Forwarded-For": "proxy.internal",
          "Via": "1.1 discobot-proxy"
        }
      }
    }
  }'

# Delete a domain's headers
curl -X PATCH http://localhost:8081/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "headers": {
      "api.anthropic.com": null
    }
  }'

# Add domains to allowlist
curl -X PATCH http://localhost:8081/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "allowlist": {
      "domains": ["*.newdomain.com"]
    }
  }'

# Enable/disable allowlist
curl -X PATCH http://localhost:8081/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "allowlist": {
      "enabled": false
    }
  }'
```

Response:
```json
{"status": "ok"}
```

### GET /health - Health Check

```bash
curl http://localhost:8081/health
```

Response:
```json
{"status": "ok"}
```

## Error Responses

All errors return JSON with an `error` field:

```json
{"error": "invalid domain pattern: foo..bar"}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request (invalid JSON, validation failed) |
| 500 | Internal server error |

## Examples

### Initial Setup

```bash
# Set complete config
curl -X POST http://localhost:8081/api/config \
  -d '{
    "allowlist": {"enabled": false},
    "headers": {
      "api.anthropic.com": {
        "set": {"Authorization": "Bearer sk-ant-xxx"}
      }
    }
  }'
```

### Add New Service

```bash
# Add OpenAI headers (keeps existing Anthropic headers)
curl -X PATCH http://localhost:8081/api/config \
  -d '{
    "headers": {
      "api.openai.com": {
        "set": {"Authorization": "Bearer sk-xxx"}
      }
    }
  }'
```

### Update Existing Service

```bash
# Update Anthropic headers (overwrites that domain only)
curl -X PATCH http://localhost:8081/api/config \
  -d '{
    "headers": {
      "api.anthropic.com": {
        "set": {
          "Authorization": "Bearer sk-ant-NEW",
          "X-New-Header": "value"
        }
      }
    }
  }'
```

### Add Forwarding Headers

```bash
# Add X-Forwarded-For to all requests (append to existing)
curl -X PATCH http://localhost:8081/api/config \
  -d '{
    "headers": {
      "*": {
        "append": {
          "X-Forwarded-For": "proxy.internal",
          "Via": "1.1 discobot-proxy"
        }
      }
    }
  }'
```

### Remove Service

```bash
# Remove OpenAI headers
curl -X PATCH http://localhost:8081/api/config \
  -d '{
    "headers": {
      "api.openai.com": null
    }
  }'
```

### Reset Everything

```bash
# Clear all config
curl -X POST http://localhost:8081/api/config \
  -d '{
    "allowlist": {"enabled": false, "domains": [], "ips": []},
    "headers": {}
  }'
```
