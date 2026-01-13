package encryption

import (
	"bytes"
	"testing"
)

func TestNewEncryptor(t *testing.T) {
	tests := []struct {
		name    string
		keyLen  int
		wantErr error
	}{
		{"valid 32-byte key", 32, nil},
		{"short key", 16, ErrInvalidKey},
		{"long key", 64, ErrInvalidKey},
		{"empty key", 0, ErrInvalidKey},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			key := make([]byte, tt.keyLen)
			_, err := NewEncryptor(key)
			if err != tt.wantErr {
				t.Errorf("NewEncryptor() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestEncryptDecrypt(t *testing.T) {
	key := []byte("01234567890123456789012345678901") // 32 bytes
	enc, err := NewEncryptor(key)
	if err != nil {
		t.Fatalf("NewEncryptor() error = %v", err)
	}

	tests := []struct {
		name      string
		plaintext []byte
	}{
		{"simple text", []byte("hello world")},
		{"empty", []byte("")},
		{"binary data", []byte{0x00, 0x01, 0x02, 0xff, 0xfe}},
		{"json", []byte(`{"api_key":"sk-test-123"}`)},
		{"long text", bytes.Repeat([]byte("a"), 10000)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ciphertext, err := enc.Encrypt(tt.plaintext)
			if err != nil {
				t.Fatalf("Encrypt() error = %v", err)
			}

			// Ciphertext should be longer than plaintext (nonce + tag)
			if len(ciphertext) <= len(tt.plaintext) {
				t.Errorf("Ciphertext should be longer than plaintext")
			}

			decrypted, err := enc.Decrypt(ciphertext)
			if err != nil {
				t.Fatalf("Decrypt() error = %v", err)
			}

			if !bytes.Equal(decrypted, tt.plaintext) {
				t.Errorf("Decrypt() = %v, want %v", decrypted, tt.plaintext)
			}
		})
	}
}

func TestDecryptInvalidCiphertext(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	enc, _ := NewEncryptor(key)

	tests := []struct {
		name       string
		ciphertext []byte
		wantErr    error
	}{
		{"too short", []byte{0x01, 0x02}, ErrInvalidCiphertext},
		{"empty", []byte{}, ErrInvalidCiphertext},
		{"corrupted", make([]byte, 50), ErrDecryptionFailed},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := enc.Decrypt(tt.ciphertext)
			if err != tt.wantErr {
				t.Errorf("Decrypt() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestDecryptWrongKey(t *testing.T) {
	key1 := []byte("01234567890123456789012345678901")
	key2 := []byte("12345678901234567890123456789012")

	enc1, _ := NewEncryptor(key1)
	enc2, _ := NewEncryptor(key2)

	plaintext := []byte("secret data")
	ciphertext, _ := enc1.Encrypt(plaintext)

	_, err := enc2.Decrypt(ciphertext)
	if err != ErrDecryptionFailed {
		t.Errorf("Decrypt with wrong key should fail, got %v", err)
	}
}

func TestEncryptJSONDecryptJSON(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	enc, _ := NewEncryptor(key)

	type credentials struct {
		APIKey       string `json:"api_key"`
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token,omitempty"`
	}

	original := credentials{
		APIKey:       "sk-test-123456",
		AccessToken:  "at-test-789",
		RefreshToken: "rt-test-abc",
	}

	ciphertext, err := enc.EncryptJSON(original)
	if err != nil {
		t.Fatalf("EncryptJSON() error = %v", err)
	}

	var decrypted credentials
	if err := enc.DecryptJSON(ciphertext, &decrypted); err != nil {
		t.Fatalf("DecryptJSON() error = %v", err)
	}

	if decrypted != original {
		t.Errorf("DecryptJSON() = %v, want %v", decrypted, original)
	}
}

func TestUniqueNonces(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	enc, _ := NewEncryptor(key)

	plaintext := []byte("same plaintext")

	// Encrypt same plaintext multiple times
	ciphertexts := make([][]byte, 10)
	for i := range ciphertexts {
		ct, err := enc.Encrypt(plaintext)
		if err != nil {
			t.Fatalf("Encrypt() error = %v", err)
		}
		ciphertexts[i] = ct
	}

	// All ciphertexts should be different (due to random nonces)
	for i := 0; i < len(ciphertexts); i++ {
		for j := i + 1; j < len(ciphertexts); j++ {
			if bytes.Equal(ciphertexts[i], ciphertexts[j]) {
				t.Error("Ciphertexts should be unique due to random nonces")
			}
		}
	}
}
