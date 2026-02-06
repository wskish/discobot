// Package config provides configuration types, loading, and validation.
package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the root configuration structure.
type Config struct {
	Proxy     ProxyConfig     `yaml:"proxy" json:"proxy"`
	TLS       TLSConfig       `yaml:"tls" json:"tls"`
	Allowlist AllowlistConfig `yaml:"allowlist" json:"allowlist"`
	Headers   HeadersConfig   `yaml:"headers" json:"headers"`
	Logging   LoggingConfig   `yaml:"logging" json:"logging"`
	Cache     CacheConfig     `yaml:"cache" json:"cache"`
}

// ProxyConfig contains proxy server settings.
type ProxyConfig struct {
	Port         int           `yaml:"port" json:"port"`
	APIPort      int           `yaml:"api_port" json:"api_port"`
	ReadTimeout  time.Duration `yaml:"read_timeout" json:"read_timeout"`
	WriteTimeout time.Duration `yaml:"write_timeout" json:"write_timeout"`
}

// TLSConfig contains TLS/certificate settings.
type TLSConfig struct {
	CertDir string `yaml:"cert_dir" json:"cert_dir"`
}

// AllowlistConfig contains connection filtering settings.
type AllowlistConfig struct {
	Enabled bool     `yaml:"enabled" json:"enabled"`
	Domains []string `yaml:"domains" json:"domains"`
	IPs     []string `yaml:"ips" json:"ips"`
}

// HeadersConfig maps domain patterns to header rules.
type HeadersConfig map[string]HeaderRule

// HeaderRule defines headers to set or append for a domain.
type HeaderRule struct {
	Conditions []Condition       `yaml:"conditions,omitempty" json:"conditions,omitempty"`
	Set        map[string]string `yaml:"set,omitempty" json:"set,omitempty"`
	Append     map[string]string `yaml:"append,omitempty" json:"append,omitempty"`
}

// Condition represents a condition that must be met for headers to be applied.
// All conditions must evaluate to true for the rule to apply.
type Condition struct {
	// Header is the name of the header to check
	Header string `yaml:"header" json:"header"`
	// Equals is the exact value the header must have
	Equals string `yaml:"equals" json:"equals"`
}

// LoggingConfig contains logging settings.
type LoggingConfig struct {
	Level       string `yaml:"level" json:"level"`
	Format      string `yaml:"format" json:"format"`
	File        string `yaml:"file" json:"file"`
	IncludeBody bool   `yaml:"include_body" json:"include_body"`
}

// CacheConfig contains caching settings.
type CacheConfig struct {
	Enabled  bool     `yaml:"enabled" json:"enabled"`
	Dir      string   `yaml:"dir" json:"dir"`
	MaxSize  int64    `yaml:"max_size" json:"max_size"` // In bytes
	Patterns []string `yaml:"patterns" json:"patterns"` // URL patterns to cache
}

// RuntimeConfig is the JSON structure for API updates.
// It contains only the fields that can be updated at runtime.
type RuntimeConfig struct {
	Allowlist *RuntimeAllowlistConfig `json:"allowlist,omitempty"`
	Headers   HeadersConfig           `json:"headers,omitempty"`
}

// RuntimeAllowlistConfig is the allowlist portion of RuntimeConfig.
type RuntimeAllowlistConfig struct {
	Enabled *bool    `json:"enabled,omitempty"`
	Domains []string `json:"domains,omitempty"`
	IPs     []string `json:"ips,omitempty"`
}

// Default returns a Config with default values.
func Default() *Config {
	return &Config{
		Proxy: ProxyConfig{
			Port:         17080,
			APIPort:      17081,
			ReadTimeout:  30 * time.Second,
			WriteTimeout: 30 * time.Second,
		},
		TLS: TLSConfig{
			CertDir: "./certs",
		},
		Allowlist: AllowlistConfig{
			Enabled: false,
			Domains: []string{},
			IPs:     []string{},
		},
		Headers: HeadersConfig{},
		Logging: LoggingConfig{
			Level:  "info",
			Format: "text",
		},
		Cache: CacheConfig{
			Enabled:  false,
			Dir:      "./cache",
			MaxSize:  20 * 1024 * 1024 * 1024, // 20GB default
			Patterns: []string{},
		},
	}
}

// Load reads and parses a configuration file.
func Load(path string) (*Config, error) {
	path = filepath.Clean(path)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := Default()
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}

	return cfg, nil
}

// Validate checks the configuration for errors.
func (c *Config) Validate() error {
	if c.Proxy.Port < 1 || c.Proxy.Port > 65535 {
		return errors.New("invalid proxy port")
	}
	if c.Proxy.APIPort < 1 || c.Proxy.APIPort > 65535 {
		return errors.New("invalid API port")
	}
	if c.Proxy.Port == c.Proxy.APIPort {
		return errors.New("proxy and API ports must be different")
	}

	// Validate domain patterns and conditions in headers
	for pattern, rule := range c.Headers {
		if !IsValidDomainPattern(pattern) {
			return fmt.Errorf("invalid header domain pattern: %s", pattern)
		}
		if err := rule.Validate(); err != nil {
			return fmt.Errorf("invalid header rule for %s: %w", pattern, err)
		}
	}

	// Validate domain patterns in allowlist
	for _, pattern := range c.Allowlist.Domains {
		if !IsValidDomainPattern(pattern) {
			return fmt.Errorf("invalid allowlist domain pattern: %s", pattern)
		}
	}

	// Validate IPs/CIDRs in allowlist
	for _, ip := range c.Allowlist.IPs {
		if _, _, err := net.ParseCIDR(ip); err != nil {
			// Try as single IP
			if net.ParseIP(ip) == nil {
				return fmt.Errorf("invalid IP/CIDR: %s", ip)
			}
		}
	}

	// Validate logging level
	switch c.Logging.Level {
	case "debug", "info", "warn", "error":
		// Valid
	default:
		return fmt.Errorf("invalid log level: %s", c.Logging.Level)
	}

	// Validate logging format
	switch c.Logging.Format {
	case "text", "json":
		// Valid
	default:
		return fmt.Errorf("invalid log format: %s", c.Logging.Format)
	}

	// Validate cache config
	if c.Cache.Enabled {
		if c.Cache.Dir == "" {
			return errors.New("cache directory cannot be empty when cache is enabled")
		}
		if c.Cache.MaxSize <= 0 {
			return errors.New("cache max_size must be positive")
		}
	}

	return nil
}

// IsValidDomainPattern validates a domain pattern.
func IsValidDomainPattern(pattern string) bool {
	if pattern == "" {
		return false
	}

	// Wildcard match all
	if pattern == "*" {
		return true
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
		// Check for multiple wildcards
		if strings.Count(pattern, "*") > 1 {
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

// Validate checks if a HeaderRule is valid.
func (r *HeaderRule) Validate() error {
	// Validate conditions
	for i, cond := range r.Conditions {
		if err := cond.Validate(); err != nil {
			return fmt.Errorf("condition %d: %w", i, err)
		}
	}
	return nil
}

// Validate checks if a Condition is valid.
func (c *Condition) Validate() error {
	if c.Header == "" {
		return errors.New("condition header name cannot be empty")
	}
	if c.Equals == "" {
		return errors.New("condition equals value cannot be empty")
	}
	return nil
}
