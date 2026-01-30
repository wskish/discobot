// Package filter provides connection filtering by domain and IP.
package filter

import (
	"net"
	"sync"

	"github.com/obot-platform/discobot/proxy/internal/injector"
)

// Filter manages domain and IP allowlists.
type Filter struct {
	mu       sync.RWMutex
	enabled  bool
	domains  []string
	cidrs    []*net.IPNet
	singleIP []net.IP
}

// New creates a new Filter.
func New() *Filter {
	return &Filter{
		enabled:  false,
		domains:  []string{},
		cidrs:    []*net.IPNet{},
		singleIP: []net.IP{},
	}
}

// SetEnabled enables or disables the filter.
func (f *Filter) SetEnabled(enabled bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.enabled = enabled
}

// IsEnabled returns whether the filter is enabled.
func (f *Filter) IsEnabled() bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.enabled
}

// SetAllowlist sets the domain and IP allowlists.
func (f *Filter) SetAllowlist(domains []string, ips []string) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.domains = make([]string, len(domains))
	copy(f.domains, domains)

	f.cidrs = make([]*net.IPNet, 0)
	f.singleIP = make([]net.IP, 0)

	for _, ip := range ips {
		if _, cidr, err := net.ParseCIDR(ip); err == nil {
			f.cidrs = append(f.cidrs, cidr)
		} else if parsed := net.ParseIP(ip); parsed != nil {
			f.singleIP = append(f.singleIP, parsed)
		}
	}
}

// AddDomains adds domains to the allowlist.
func (f *Filter) AddDomains(domains []string) {
	f.mu.Lock()
	defer f.mu.Unlock()

	for _, d := range domains {
		// Check if already exists
		exists := false
		for _, existing := range f.domains {
			if existing == d {
				exists = true
				break
			}
		}
		if !exists {
			f.domains = append(f.domains, d)
		}
	}
}

// AddIPs adds IPs or CIDRs to the allowlist.
func (f *Filter) AddIPs(ips []string) {
	f.mu.Lock()
	defer f.mu.Unlock()

	for _, ip := range ips {
		if _, cidr, err := net.ParseCIDR(ip); err == nil {
			f.cidrs = append(f.cidrs, cidr)
		} else if parsed := net.ParseIP(ip); parsed != nil {
			f.singleIP = append(f.singleIP, parsed)
		}
	}
}

// RemoveDomain removes a domain from the allowlist.
func (f *Filter) RemoveDomain(domain string) {
	f.mu.Lock()
	defer f.mu.Unlock()

	for i, d := range f.domains {
		if d == domain {
			f.domains = append(f.domains[:i], f.domains[i+1:]...)
			return
		}
	}
}

// AllowHost checks if a host (domain or IP) is allowed.
func (f *Filter) AllowHost(host string) bool {
	f.mu.RLock()
	defer f.mu.RUnlock()

	// If filtering is disabled, allow all
	if !f.enabled {
		return true
	}

	// If no allowlist configured, block all (when enabled)
	if len(f.domains) == 0 && len(f.cidrs) == 0 && len(f.singleIP) == 0 {
		return false
	}

	// Strip port if present
	hostOnly, _, err := net.SplitHostPort(host)
	if err != nil {
		hostOnly = host
	}

	// Check if it's an IP address
	if ip := net.ParseIP(hostOnly); ip != nil {
		return f.allowIP(ip)
	}

	// Check domain patterns
	return f.allowDomain(hostOnly)
}

func (f *Filter) allowDomain(domain string) bool {
	for _, pattern := range f.domains {
		if injector.MatchDomain(pattern, domain) {
			return true
		}
	}
	return false
}

func (f *Filter) allowIP(ip net.IP) bool {
	// Check single IPs
	for _, allowed := range f.singleIP {
		if allowed.Equal(ip) {
			return true
		}
	}

	// Check CIDR ranges
	for _, cidr := range f.cidrs {
		if cidr.Contains(ip) {
			return true
		}
	}

	return false
}
