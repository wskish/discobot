// Package crypto provides encryption utilities for secure credential storage.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
)

var (
	// ErrInvalidKey indicates the encryption key is invalid (must be 32 bytes for AES-256)
	ErrInvalidKey = errors.New("encryption key must be 32 bytes")
	// ErrInvalidCiphertext indicates the ciphertext is too short or corrupted
	ErrInvalidCiphertext = errors.New("ciphertext too short")
	// ErrDecryptionFailed indicates decryption failed (wrong key or corrupted data)
	ErrDecryptionFailed = errors.New("decryption failed")
)

// Encryptor provides AES-256-GCM encryption and decryption.
type Encryptor struct {
	gcm cipher.AEAD
}

// NewEncryptor creates a new Encryptor with the given 32-byte key.
func NewEncryptor(key []byte) (*Encryptor, error) {
	if len(key) != 32 {
		return nil, ErrInvalidKey
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	return &Encryptor{gcm: gcm}, nil
}

// Encrypt encrypts plaintext using AES-256-GCM.
// The nonce is prepended to the ciphertext.
func (e *Encryptor) Encrypt(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, e.gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	// Seal appends the ciphertext to dst, which we set to the nonce
	// Result is: nonce || ciphertext || tag
	return e.gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// Decrypt decrypts ciphertext that was encrypted with Encrypt.
// Expects the nonce to be prepended to the ciphertext.
func (e *Encryptor) Decrypt(ciphertext []byte) ([]byte, error) {
	nonceSize := e.gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, ErrInvalidCiphertext
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := e.gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, ErrDecryptionFailed
	}

	return plaintext, nil
}

// EncryptJSON encrypts a value as JSON using AES-256-GCM.
func (e *Encryptor) EncryptJSON(v interface{}) ([]byte, error) {
	plaintext, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return e.Encrypt(plaintext)
}

// DecryptJSON decrypts ciphertext and unmarshals the JSON result into v.
func (e *Encryptor) DecryptJSON(ciphertext []byte, v interface{}) error {
	plaintext, err := e.Decrypt(ciphertext)
	if err != nil {
		return err
	}
	return json.Unmarshal(plaintext, v)
}
