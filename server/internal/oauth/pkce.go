// Package oauth provides OAuth utilities for AI provider authentication.
package oauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

// PKCEChallenge represents a PKCE code verifier and challenge pair.
type PKCEChallenge struct {
	// CodeVerifier is the secret random string (43-128 chars)
	CodeVerifier string `json:"code_verifier"`
	// CodeChallenge is the SHA256 hash of the verifier, base64url encoded
	CodeChallenge string `json:"code_challenge"`
	// CodeChallengeMethod is always "S256" for SHA256
	CodeChallengeMethod string `json:"code_challenge_method"`
}

// GeneratePKCE generates a new PKCE code verifier and challenge.
// The verifier is a cryptographically random 64-character string.
func GeneratePKCE() (*PKCEChallenge, error) {
	// Generate 48 bytes of random data (will become 64 base64url chars)
	verifierBytes := make([]byte, 48)
	if _, err := rand.Read(verifierBytes); err != nil {
		return nil, fmt.Errorf("failed to generate random bytes: %w", err)
	}

	// Base64url encode without padding for the verifier
	verifier := base64.RawURLEncoding.EncodeToString(verifierBytes)

	// SHA256 hash the verifier
	hash := sha256.Sum256([]byte(verifier))

	// Base64url encode the hash without padding for the challenge
	challenge := base64.RawURLEncoding.EncodeToString(hash[:])

	return &PKCEChallenge{
		CodeVerifier:        verifier,
		CodeChallenge:       challenge,
		CodeChallengeMethod: "S256",
	}, nil
}

// GenerateState generates a random state string for OAuth flows.
// The state is used to prevent CSRF attacks.
func GenerateState() (string, error) {
	stateBytes := make([]byte, 32)
	if _, err := rand.Read(stateBytes); err != nil {
		return "", fmt.Errorf("failed to generate state: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(stateBytes), nil
}
