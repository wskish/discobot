package oauth

import (
	"testing"
)

func TestGeneratePKCE(t *testing.T) {
	pkce, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("GeneratePKCE() error = %v", err)
	}

	// Verifier should be 64 characters (48 bytes base64url encoded)
	if len(pkce.CodeVerifier) != 64 {
		t.Errorf("CodeVerifier length = %d, want 64", len(pkce.CodeVerifier))
	}

	// Challenge should be 43 characters (32 bytes SHA256 base64url encoded without padding)
	if len(pkce.CodeChallenge) != 43 {
		t.Errorf("CodeChallenge length = %d, want 43", len(pkce.CodeChallenge))
	}

	// Method should be S256
	if pkce.CodeChallengeMethod != "S256" {
		t.Errorf("CodeChallengeMethod = %s, want S256", pkce.CodeChallengeMethod)
	}
}

func TestGeneratePKCE_Unique(t *testing.T) {
	// Generate multiple PKCE challenges and ensure they're unique
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		pkce, err := GeneratePKCE()
		if err != nil {
			t.Fatalf("GeneratePKCE() error = %v", err)
		}
		if seen[pkce.CodeVerifier] {
			t.Error("Generated duplicate verifier")
		}
		seen[pkce.CodeVerifier] = true
	}
}

func TestVerifyPKCE(t *testing.T) {
	pkce, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("GeneratePKCE() error = %v", err)
	}

	// Valid verification
	if !VerifyPKCE(pkce.CodeVerifier, pkce.CodeChallenge) {
		t.Error("VerifyPKCE() should return true for valid verifier/challenge pair")
	}

	// Invalid verification - wrong verifier
	if VerifyPKCE("wrong-verifier", pkce.CodeChallenge) {
		t.Error("VerifyPKCE() should return false for wrong verifier")
	}

	// Invalid verification - wrong challenge
	if VerifyPKCE(pkce.CodeVerifier, "wrong-challenge") {
		t.Error("VerifyPKCE() should return false for wrong challenge")
	}
}

func TestVerifyPKCE_KnownValues(t *testing.T) {
	// Test with known values from RFC 7636 Appendix B
	// Note: This is a simplified test since the RFC example uses a different encoding
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	expectedChallenge := "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

	if !VerifyPKCE(verifier, expectedChallenge) {
		t.Error("VerifyPKCE() should return true for RFC example values")
	}
}

func TestGenerateState(t *testing.T) {
	state, err := GenerateState()
	if err != nil {
		t.Fatalf("GenerateState() error = %v", err)
	}

	// State should be 43 characters (32 bytes base64url encoded without padding)
	if len(state) != 43 {
		t.Errorf("State length = %d, want 43", len(state))
	}
}

func TestGenerateState_Unique(t *testing.T) {
	// Generate multiple states and ensure they're unique
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		state, err := GenerateState()
		if err != nil {
			t.Fatalf("GenerateState() error = %v", err)
		}
		if seen[state] {
			t.Error("Generated duplicate state")
		}
		seen[state] = true
	}
}
