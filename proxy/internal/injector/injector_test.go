package injector

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/obot-platform/discobot/proxy/internal/config"
)

func TestInjector_SetRules(t *testing.T) {
	inj := New()

	rules := config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Set: map[string]string{
				"Authorization": "Bearer token",
			},
		},
		"*.github.com": config.HeaderRule{
			Set: map[string]string{
				"X-GitHub": "true",
			},
			Append: map[string]string{
				"X-Forwarded-For": "proxy",
			},
		},
	}

	inj.SetRules(rules)

	got := inj.GetRules()
	if len(got) != 2 {
		t.Errorf("GetRules() returned %d rules, want 2", len(got))
	}
}

func TestInjector_Apply_ExactMatch(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Set: map[string]string{
				"Authorization": "Bearer token",
				"X-Custom":      "value",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.example.com/test", nil)
	inj.Apply(req)

	if got := req.Header.Get("Authorization"); got != "Bearer token" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer token")
	}
	if got := req.Header.Get("X-Custom"); got != "value" {
		t.Errorf("X-Custom = %q, want %q", got, "value")
	}
}

func TestInjector_Apply_WildcardMatch(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"*.github.com": config.HeaderRule{
			Set: map[string]string{
				"X-GitHub": "true",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.github.com/test", nil)
	inj.Apply(req)

	if got := req.Header.Get("X-GitHub"); got != "true" {
		t.Errorf("X-GitHub = %q, want %q", got, "true")
	}
}

func TestInjector_Apply_NoMatch(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Set: map[string]string{
				"Authorization": "Bearer token",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://other.com/test", nil)
	inj.Apply(req)

	if got := req.Header.Get("Authorization"); got != "" {
		t.Errorf("Authorization = %q, want empty", got)
	}
}

func TestInjector_Apply_Append(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"*": config.HeaderRule{
			Append: map[string]string{
				"X-Forwarded-For": "proxy.internal",
			},
		},
	})

	// Test appending to existing header
	req := httptest.NewRequest("GET", "http://example.com/test", nil)
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	inj.Apply(req)

	expected := "1.2.3.4, proxy.internal"
	if got := req.Header.Get("X-Forwarded-For"); got != expected {
		t.Errorf("X-Forwarded-For = %q, want %q", got, expected)
	}

	// Test setting when header doesn't exist
	req2 := httptest.NewRequest("GET", "http://example.com/test", nil)
	inj.Apply(req2)

	if got := req2.Header.Get("X-Forwarded-For"); got != "proxy.internal" {
		t.Errorf("X-Forwarded-For = %q, want %q", got, "proxy.internal")
	}
}

func TestInjector_Apply_SetAndAppend(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Set: map[string]string{
				"Authorization": "Bearer token",
			},
			Append: map[string]string{
				"Via": "1.1 proxy",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.example.com/test", nil)
	req.Header.Set("Via", "1.1 client")
	inj.Apply(req)

	if got := req.Header.Get("Authorization"); got != "Bearer token" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer token")
	}

	expected := "1.1 client, 1.1 proxy"
	if got := req.Header.Get("Via"); got != expected {
		t.Errorf("Via = %q, want %q", got, expected)
	}
}

func TestInjector_SetDomainHeaders(t *testing.T) {
	inj := New()

	// Add first domain
	inj.SetDomainHeaders("api.example.com", config.HeaderRule{
		Set: map[string]string{"X-Test": "value1"},
	})

	// Add second domain
	inj.SetDomainHeaders("api.other.com", config.HeaderRule{
		Set: map[string]string{"X-Test": "value2"},
	})

	rules := inj.GetRules()
	if len(rules) != 2 {
		t.Errorf("GetRules() returned %d rules, want 2", len(rules))
	}

	// Update first domain
	inj.SetDomainHeaders("api.example.com", config.HeaderRule{
		Set: map[string]string{"X-Test": "updated"},
	})

	rules = inj.GetRules()
	if len(rules) != 2 {
		t.Errorf("GetRules() returned %d rules, want 2", len(rules))
	}
}

func TestInjector_DeleteDomain(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Set: map[string]string{"X-Test": "value"},
		},
		"api.other.com": config.HeaderRule{
			Set: map[string]string{"X-Test": "value"},
		},
	})

	inj.DeleteDomain("api.example.com")

	rules := inj.GetRules()
	if len(rules) != 1 {
		t.Errorf("GetRules() returned %d rules, want 1", len(rules))
	}
	if _, ok := rules["api.example.com"]; ok {
		t.Error("api.example.com should have been deleted")
	}
}

func TestInjector_HostWithPort(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Set: map[string]string{"X-Test": "value"},
		},
	})

	req := &http.Request{
		Host:   "api.example.com:8080",
		Header: make(http.Header),
	}
	inj.Apply(req)

	if got := req.Header.Get("X-Test"); got != "value" {
		t.Errorf("X-Test = %q, want %q", got, "value")
	}
}

func TestInjector_Apply_Conditions_Match(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Conditions: []config.Condition{
				{Header: "X-Custom-Header", Equals: "special-value"},
			},
			Set: map[string]string{
				"Authorization": "Bearer token",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.example.com/test", nil)
	req.Header.Set("X-Custom-Header", "special-value")
	inj.Apply(req)

	if got := req.Header.Get("Authorization"); got != "Bearer token" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer token")
	}
}

func TestInjector_Apply_Conditions_NoMatch(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Conditions: []config.Condition{
				{Header: "X-Custom-Header", Equals: "special-value"},
			},
			Set: map[string]string{
				"Authorization": "Bearer token",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.example.com/test", nil)
	req.Header.Set("X-Custom-Header", "wrong-value")
	inj.Apply(req)

	// Header should not be set because condition didn't match
	if got := req.Header.Get("Authorization"); got != "" {
		t.Errorf("Authorization = %q, want empty (condition didn't match)", got)
	}
}

func TestInjector_Apply_Conditions_MissingHeader(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Conditions: []config.Condition{
				{Header: "X-Custom-Header", Equals: "special-value"},
			},
			Set: map[string]string{
				"Authorization": "Bearer token",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.example.com/test", nil)
	// X-Custom-Header is not set
	inj.Apply(req)

	// Header should not be set because condition header is missing
	if got := req.Header.Get("Authorization"); got != "" {
		t.Errorf("Authorization = %q, want empty (condition header missing)", got)
	}
}

func TestInjector_Apply_MultipleConditions_AllMatch(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Conditions: []config.Condition{
				{Header: "X-Env", Equals: "production"},
				{Header: "X-Region", Equals: "us-east-1"},
			},
			Set: map[string]string{
				"Authorization": "Bearer prod-token",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.example.com/test", nil)
	req.Header.Set("X-Env", "production")
	req.Header.Set("X-Region", "us-east-1")
	inj.Apply(req)

	if got := req.Header.Get("Authorization"); got != "Bearer prod-token" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer prod-token")
	}
}

func TestInjector_Apply_MultipleConditions_OneDoesNotMatch(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Conditions: []config.Condition{
				{Header: "X-Env", Equals: "production"},
				{Header: "X-Region", Equals: "us-east-1"},
			},
			Set: map[string]string{
				"Authorization": "Bearer prod-token",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.example.com/test", nil)
	req.Header.Set("X-Env", "production")
	req.Header.Set("X-Region", "us-west-2") // Wrong region
	inj.Apply(req)

	// Header should not be set because one condition didn't match
	if got := req.Header.Get("Authorization"); got != "" {
		t.Errorf("Authorization = %q, want empty (one condition didn't match)", got)
	}
}

func TestInjector_Apply_NoConditions(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			// No conditions specified - should always apply
			Set: map[string]string{
				"Authorization": "Bearer token",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.example.com/test", nil)
	inj.Apply(req)

	if got := req.Header.Get("Authorization"); got != "Bearer token" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer token")
	}
}

func TestInjector_Apply_Conditions_WithAppend(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Conditions: []config.Condition{
				{Header: "X-Auth-Type", Equals: "internal"},
			},
			Set: map[string]string{
				"Authorization": "Bearer internal-token",
			},
			Append: map[string]string{
				"X-Forwarded-For": "proxy.internal",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.example.com/test", nil)
	req.Header.Set("X-Auth-Type", "internal")
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	inj.Apply(req)

	if got := req.Header.Get("Authorization"); got != "Bearer internal-token" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer internal-token")
	}

	expected := "1.2.3.4, proxy.internal"
	if got := req.Header.Get("X-Forwarded-For"); got != expected {
		t.Errorf("X-Forwarded-For = %q, want %q", got, expected)
	}
}

func TestInjector_Apply_Conditions_CaseSensitive(t *testing.T) {
	inj := New()
	inj.SetRules(config.HeadersConfig{
		"api.example.com": config.HeaderRule{
			Conditions: []config.Condition{
				{Header: "X-Custom", Equals: "Value"},
			},
			Set: map[string]string{
				"Authorization": "Bearer token",
			},
		},
	})

	req := httptest.NewRequest("GET", "http://api.example.com/test", nil)
	req.Header.Set("X-Custom", "value") // Different case
	inj.Apply(req)

	// Header should not be set because value is case-sensitive
	if got := req.Header.Get("Authorization"); got != "" {
		t.Errorf("Authorization = %q, want empty (case mismatch)", got)
	}
}
