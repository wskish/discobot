package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsValidDomainPattern(t *testing.T) {
	tests := []struct {
		pattern string
		valid   bool
	}{
		// Valid patterns
		{"example.com", true},
		{"api.example.com", true},
		{"*.example.com", true},
		{"api.*", true},
		{"*", true},
		{"sub.domain.example.com", true},
		{"example-site.com", true},

		// Invalid patterns
		{"", false},
		{"*example.com", false},    // * not followed by .
		{"example*.com", false},    // * in middle
		{"*.*.example.com", false}, // Multiple wildcards
		{"example.com/path", false},
		{"example com", false}, // Space
	}

	for _, tt := range tests {
		t.Run(tt.pattern, func(t *testing.T) {
			got := IsValidDomainPattern(tt.pattern)
			if got != tt.valid {
				t.Errorf("IsValidDomainPattern(%q) = %v, want %v", tt.pattern, got, tt.valid)
			}
		})
	}
}

func TestDefault(t *testing.T) {
	cfg := Default()

	if cfg.Proxy.Port != 17080 {
		t.Errorf("Default proxy port = %d, want 17080", cfg.Proxy.Port)
	}
	if cfg.Proxy.APIPort != 17081 {
		t.Errorf("Default API port = %d, want 17081", cfg.Proxy.APIPort)
	}
	if cfg.Allowlist.Enabled {
		t.Error("Default allowlist.enabled = true, want false")
	}
	if cfg.Logging.Level != "info" {
		t.Errorf("Default logging.level = %q, want %q", cfg.Logging.Level, "info")
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		modify  func(*Config)
		wantErr bool
	}{
		{
			name:    "valid default config",
			modify:  func(_ *Config) {},
			wantErr: false,
		},
		{
			name: "invalid proxy port",
			modify: func(c *Config) {
				c.Proxy.Port = 0
			},
			wantErr: true,
		},
		{
			name: "invalid API port",
			modify: func(c *Config) {
				c.Proxy.APIPort = 70000
			},
			wantErr: true,
		},
		{
			name: "same proxy and API port",
			modify: func(c *Config) {
				c.Proxy.Port = 8080
				c.Proxy.APIPort = 8080
			},
			wantErr: true,
		},
		{
			name: "invalid header domain pattern",
			modify: func(c *Config) {
				c.Headers = HeadersConfig{
					"invalid**pattern": HeaderRule{
						Set: map[string]string{"X-Test": "value"},
					},
				}
			},
			wantErr: true,
		},
		{
			name: "invalid allowlist domain",
			modify: func(c *Config) {
				c.Allowlist.Domains = []string{"valid.com", "invalid**pattern"}
			},
			wantErr: true,
		},
		{
			name: "invalid IP in allowlist",
			modify: func(c *Config) {
				c.Allowlist.IPs = []string{"not-an-ip"}
			},
			wantErr: true,
		},
		{
			name: "valid CIDR in allowlist",
			modify: func(c *Config) {
				c.Allowlist.IPs = []string{"10.0.0.0/8", "192.168.1.1"}
			},
			wantErr: false,
		},
		{
			name: "invalid log level",
			modify: func(c *Config) {
				c.Logging.Level = "invalid"
			},
			wantErr: true,
		},
		{
			name: "invalid log format",
			modify: func(c *Config) {
				c.Logging.Format = "invalid"
			},
			wantErr: true,
		},
		{
			name: "valid header conditions",
			modify: func(c *Config) {
				c.Headers = HeadersConfig{
					"api.example.com": HeaderRule{
						Conditions: []Condition{
							{Header: "X-Custom", Equals: "value"},
						},
						Set: map[string]string{"Authorization": "Bearer token"},
					},
				}
			},
			wantErr: false,
		},
		{
			name: "invalid header condition - empty header name",
			modify: func(c *Config) {
				c.Headers = HeadersConfig{
					"api.example.com": HeaderRule{
						Conditions: []Condition{
							{Header: "", Equals: "value"},
						},
						Set: map[string]string{"Authorization": "Bearer token"},
					},
				}
			},
			wantErr: true,
		},
		{
			name: "invalid header condition - empty equals value",
			modify: func(c *Config) {
				c.Headers = HeadersConfig{
					"api.example.com": HeaderRule{
						Conditions: []Condition{
							{Header: "X-Custom", Equals: ""},
						},
						Set: map[string]string{"Authorization": "Bearer token"},
					},
				}
			},
			wantErr: true,
		},
		{
			name: "valid multiple conditions",
			modify: func(c *Config) {
				c.Headers = HeadersConfig{
					"api.example.com": HeaderRule{
						Conditions: []Condition{
							{Header: "X-Env", Equals: "prod"},
							{Header: "X-Region", Equals: "us-east-1"},
						},
						Set: map[string]string{"Authorization": "Bearer token"},
					},
				}
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Default()
			tt.modify(cfg)
			err := cfg.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestLoad(t *testing.T) {
	// Create a temporary config file
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")

	content := `
proxy:
  port: 9090
  api_port: 9091
  read_timeout: 60s
  write_timeout: 60s

tls:
  cert_dir: ./test-certs

allowlist:
  enabled: true
  domains:
    - "*.example.com"
    - "api.test.com"
  ips:
    - "10.0.0.0/8"

headers:
  "api.example.com":
    set:
      "Authorization": "Bearer test-token"
    append:
      "X-Forwarded-For": "proxy"

logging:
  level: debug
  format: json
`

	if err := os.WriteFile(configPath, []byte(content), 0644); err != nil {
		t.Fatalf("Failed to write config file: %v", err)
	}

	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.Proxy.Port != 9090 {
		t.Errorf("Proxy.Port = %d, want 9090", cfg.Proxy.Port)
	}
	if cfg.Proxy.APIPort != 9091 {
		t.Errorf("Proxy.APIPort = %d, want 9091", cfg.Proxy.APIPort)
	}
	if !cfg.Allowlist.Enabled {
		t.Error("Allowlist.Enabled = false, want true")
	}
	if len(cfg.Allowlist.Domains) != 2 {
		t.Errorf("len(Allowlist.Domains) = %d, want 2", len(cfg.Allowlist.Domains))
	}
	if len(cfg.Headers) != 1 {
		t.Errorf("len(Headers) = %d, want 1", len(cfg.Headers))
	}
	if cfg.Logging.Level != "debug" {
		t.Errorf("Logging.Level = %q, want %q", cfg.Logging.Level, "debug")
	}
}

func TestLoadNonExistent(t *testing.T) {
	_, err := Load("/nonexistent/path/config.yaml")
	if err == nil {
		t.Error("Load() expected error for nonexistent file")
	}
}

func TestLoadInvalid(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")

	// Invalid YAML
	content := `
proxy:
  port: invalid
`
	if err := os.WriteFile(configPath, []byte(content), 0644); err != nil {
		t.Fatalf("Failed to write config file: %v", err)
	}

	_, err := Load(configPath)
	if err == nil {
		t.Error("Load() expected error for invalid YAML")
	}
}
