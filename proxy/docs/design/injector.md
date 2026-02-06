# Injector Module

Thread-safe header injection with domain pattern matching. Supports both setting (replace) and appending to headers.

## Files

| File | Purpose |
|------|---------|
| `internal/injector/injector.go` | Thread-safe header storage and application |
| `internal/injector/matcher.go` | Glob-style domain pattern matching |

## Header Operations

Two operations are supported:

| Operation | Behavior | Use Case |
|-----------|----------|----------|
| `set` | Replace header value (or create if missing) | Authorization, API keys |
| `append` | Append to existing value with `, ` separator | X-Forwarded-For, Via |

## Types

```go
// HeaderRule defines headers to set or append for a domain
type HeaderRule struct {
    Conditions []Condition       `json:"conditions,omitempty" yaml:"conditions,omitempty"`
    Set        map[string]string `json:"set,omitempty" yaml:"set,omitempty"`
    Append     map[string]string `json:"append,omitempty" yaml:"append,omitempty"`
}

// Condition represents a condition that must be met for headers to be applied
// All conditions must evaluate to true for the rule to apply
type Condition struct {
    Header string `json:"header" yaml:"header"` // Header name to check
    Equals string `json:"equals" yaml:"equals"` // Exact value required
}

// HeadersConfig maps domain patterns to header rules
type HeadersConfig map[string]HeaderRule
```

## Injector

```go
type Injector struct {
    mu    sync.RWMutex
    rules map[string]HeaderRule // domain pattern -> header rule
}

func New() *Injector {
    return &Injector{
        rules: make(map[string]HeaderRule),
    }
}

// SetRules replaces all rules atomically
func (i *Injector) SetRules(rules map[string]HeaderRule) {
    i.mu.Lock()
    defer i.mu.Unlock()

    // Deep copy to prevent external mutation
    i.rules = make(map[string]HeaderRule)
    for domain, rule := range rules {
        i.rules[domain] = HeaderRule{
            Set:    copyMap(rule.Set),
            Append: copyMap(rule.Append),
        }
    }
}

// SetDomainHeaders sets headers for a single domain
func (i *Injector) SetDomainHeaders(domain string, rule HeaderRule) {
    i.mu.Lock()
    defer i.mu.Unlock()

    if (rule.Set == nil || len(rule.Set) == 0) &&
       (rule.Append == nil || len(rule.Append) == 0) {
        delete(i.rules, domain)
        return
    }

    i.rules[domain] = HeaderRule{
        Set:    copyMap(rule.Set),
        Append: copyMap(rule.Append),
    }
}

// DeleteDomain removes all headers for a domain
func (i *Injector) DeleteDomain(domain string) {
    i.mu.Lock()
    defer i.mu.Unlock()
    delete(i.rules, domain)
}

// Apply injects matching headers into the request
func (i *Injector) Apply(req *http.Request) {
    i.mu.RLock()
    defer i.mu.RUnlock()

    host := extractHost(req.Host) // Remove port if present

    // Try exact match first
    if rule, ok := i.rules[host]; ok {
        applyRule(req, rule)
        return
    }

    // Try pattern matches
    for pattern, rule := range i.rules {
        if matchDomain(pattern, host) {
            applyRule(req, rule)
            return // First match wins
        }
    }
}

func applyRule(req *http.Request, rule HeaderRule) {
    // Check if all conditions are met
    if !evaluateConditions(req, rule.Conditions) {
        return
    }

    // Apply "set" headers (replace)
    for key, value := range rule.Set {
        req.Header.Set(key, value)
    }

    // Apply "append" headers
    for key, value := range rule.Append {
        existing := req.Header.Get(key)
        if existing == "" {
            req.Header.Set(key, value)
        } else {
            req.Header.Set(key, existing+", "+value)
        }
    }
}

// evaluateConditions checks if all conditions are met
// Returns true if there are no conditions or all conditions pass
func evaluateConditions(req *http.Request, conditions []Condition) bool {
    // No conditions means always apply
    if len(conditions) == 0 {
        return true
    }

    // All conditions must be true (AND logic)
    for _, cond := range conditions {
        headerValue := req.Header.Get(cond.Header)
        if headerValue != cond.Equals {
            return false
        }
    }

    return true
}

func extractHost(hostPort string) string {
    host, _, err := net.SplitHostPort(hostPort)
    if err != nil {
        return hostPort // No port present
    }
    return host
}

func copyMap(m map[string]string) map[string]string {
    if m == nil {
        return nil
    }
    c := make(map[string]string, len(m))
    for k, v := range m {
        c[k] = v
    }
    return c
}
```

## Domain Pattern Matching

```go
// matchDomain checks if host matches the pattern
// Supported patterns:
//   - "example.com"       - exact match
//   - "*.example.com"     - matches any subdomain
//   - "api.*"             - matches api.com, api.io, etc.
//   - "*"                 - matches everything
func matchDomain(pattern, host string) bool {
    // Exact match
    if pattern == host {
        return true
    }

    // Wildcard match all
    if pattern == "*" {
        return true
    }

    // Prefix wildcard: *.example.com
    if strings.HasPrefix(pattern, "*.") {
        suffix := pattern[1:] // .example.com
        return strings.HasSuffix(host, suffix)
    }

    // Suffix wildcard: api.*
    if strings.HasSuffix(pattern, ".*") {
        prefix := pattern[:len(pattern)-2] // api
        return strings.HasPrefix(host, prefix+".")
    }

    return false
}

// isValidDomainPattern validates a domain pattern
func isValidDomainPattern(pattern string) bool {
    if pattern == "" {
        return false
    }

    // Check for valid characters
    for _, c := range pattern {
        if !isValidDomainChar(c) && c != '*' {
            return false
        }
    }

    // Wildcard must be at start or end, not middle
    if strings.Contains(pattern, "*") {
        if !strings.HasPrefix(pattern, "*.") &&
           !strings.HasSuffix(pattern, ".*") &&
           pattern != "*" {
            return false
        }
    }

    return true
}

func isValidDomainChar(c rune) bool {
    return (c >= 'a' && c <= 'z') ||
           (c >= 'A' && c <= 'Z') ||
           (c >= '0' && c <= '9') ||
           c == '-' || c == '.'
}
```

## Usage Example

```go
injector := injector.New()

// Set rules from config
injector.SetRules(map[string]HeaderRule{
    "api.anthropic.com": {
        Set: map[string]string{
            "Authorization": "Bearer sk-ant-xxx",
            "X-Custom":      "value",
        },
    },
    "*.github.com": {
        // Conditional header: only apply if X-Auth-Type equals "enterprise"
        Conditions: []Condition{
            {Header: "X-Auth-Type", Equals: "enterprise"},
        },
        Set: map[string]string{
            "Authorization": "token ghp_xxx",
        },
        Append: map[string]string{
            "X-Forwarded-For": "proxy.internal",
        },
    },
    "api.example.com": {
        // Multiple conditions: ALL must match (AND logic)
        Conditions: []Condition{
            {Header: "X-Environment", Equals: "production"},
            {Header: "X-Region", Equals: "us-east-1"},
        },
        Set: map[string]string{
            "Authorization": "Bearer prod-token",
        },
    },
})

// Or set individual domain (typically via API)
injector.SetDomainHeaders("api.openai.com", HeaderRule{
    Set: map[string]string{
        "Authorization": "Bearer sk-xxx",
    },
})

// Apply to request (called by proxy)
// If request already has X-Forwarded-For: 1.2.3.4
// After apply: X-Forwarded-For: 1.2.3.4, proxy.internal
// (only if conditions are met)
injector.Apply(req)
```

## Match Priority

1. **Exact match** - `api.anthropic.com` matches only `api.anthropic.com`
2. **Pattern match** - First matching pattern wins (order not guaranteed)

For deterministic behavior, avoid overlapping patterns. If you have both `*.github.com` and `api.github.com`, define them explicitly:

```yaml
headers:
  "api.github.com":           # Exact match takes priority
    set:
      "X-Specific": "api"
  "*.github.com":             # Catches everything else
    set:
      "X-General": "github"
```

## Conditional Header Injection

### Overview

Conditions allow you to restrict when headers are applied based on the incoming request's headers. This is useful for:

- Environment-specific authentication (production vs staging)
- Region-based routing headers
- Client-type specific headers
- Feature flags controlled by request headers

### Condition Matching

- All conditions in a rule must be true for headers to be applied (AND logic)
- If no conditions are specified, headers are always applied (backward compatible)
- Condition matching is case-sensitive for header values
- If a required header is missing, the condition fails

### Examples

#### Single Condition

Only inject authorization header for production requests:

```yaml
headers:
  "api.example.com":
    conditions:
      - header: "X-Environment"
        equals: "production"
    set:
      "Authorization": "Bearer prod-token"
```

#### Multiple Conditions

Only inject headers when both environment and region match:

```yaml
headers:
  "api.example.com":
    conditions:
      - header: "X-Environment"
        equals: "production"
      - header: "X-Region"
        equals: "us-east-1"
    set:
      "Authorization": "Bearer prod-us-east-token"
```

#### Different Tokens per Environment

Use multiple rules for different environments:

```yaml
headers:
  "api.example.com":
    conditions:
      - header: "X-Environment"
        equals: "production"
    set:
      "Authorization": "Bearer prod-token"

  "api.example.com":
    conditions:
      - header: "X-Environment"
        equals: "staging"
    set:
      "Authorization": "Bearer staging-token"
```

Note: Since domain patterns are stored in a map, only one of these would be kept. For multiple conditions on the same domain, use different domain patterns or handle in your application logic.
