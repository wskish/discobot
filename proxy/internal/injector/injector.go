package injector

import (
	"net"
	"net/http"
	"sync"

	"github.com/obot-platform/discobot/proxy/internal/config"
)

// Injector manages header injection rules.
type Injector struct {
	mu    sync.RWMutex
	rules map[string]config.HeaderRule
}

// New creates a new Injector.
func New() *Injector {
	return &Injector{
		rules: make(map[string]config.HeaderRule),
	}
}

// SetRules replaces all rules atomically.
func (i *Injector) SetRules(rules config.HeadersConfig) {
	i.mu.Lock()
	defer i.mu.Unlock()

	i.rules = make(map[string]config.HeaderRule)
	for domain, rule := range rules {
		i.rules[domain] = config.HeaderRule{
			Set:    copyMap(rule.Set),
			Append: copyMap(rule.Append),
		}
	}
}

// SetDomainHeaders sets headers for a single domain.
func (i *Injector) SetDomainHeaders(domain string, rule config.HeaderRule) {
	i.mu.Lock()
	defer i.mu.Unlock()

	if len(rule.Set) == 0 && len(rule.Append) == 0 {
		delete(i.rules, domain)
		return
	}

	i.rules[domain] = config.HeaderRule{
		Set:    copyMap(rule.Set),
		Append: copyMap(rule.Append),
	}
}

// DeleteDomain removes all headers for a domain.
func (i *Injector) DeleteDomain(domain string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	delete(i.rules, domain)
}

// MatchResult contains information about a header injection match.
type MatchResult struct {
	Matched bool
	Pattern string
	Host    string
	Headers []string // Names of headers that were set/appended
}

// Apply injects matching headers into the request.
// Returns match information for logging purposes.
func (i *Injector) Apply(req *http.Request) MatchResult {
	i.mu.RLock()
	defer i.mu.RUnlock()

	host := extractHost(req.Host)

	// Try exact match first
	if rule, ok := i.rules[host]; ok {
		headers := applyRule(req, rule)
		return MatchResult{Matched: true, Pattern: host, Host: host, Headers: headers}
	}

	// Try pattern matches
	for pattern, rule := range i.rules {
		if MatchDomain(pattern, host) {
			headers := applyRule(req, rule)
			return MatchResult{Matched: true, Pattern: pattern, Host: host, Headers: headers}
		}
	}

	return MatchResult{Matched: false, Host: host}
}

// GetRules returns a copy of all rules (for testing).
func (i *Injector) GetRules() map[string]config.HeaderRule {
	i.mu.RLock()
	defer i.mu.RUnlock()

	result := make(map[string]config.HeaderRule, len(i.rules))
	for k, v := range i.rules {
		result[k] = config.HeaderRule{
			Set:    copyMap(v.Set),
			Append: copyMap(v.Append),
		}
	}
	return result
}

func applyRule(req *http.Request, rule config.HeaderRule) []string {
	var headers []string

	// Apply "set" headers (replace)
	for key, value := range rule.Set {
		req.Header.Set(key, value)
		headers = append(headers, key)
	}

	// Apply "append" headers
	for key, value := range rule.Append {
		existing := req.Header.Get(key)
		if existing == "" {
			req.Header.Set(key, value)
		} else {
			req.Header.Set(key, existing+", "+value)
		}
		headers = append(headers, key)
	}

	return headers
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
