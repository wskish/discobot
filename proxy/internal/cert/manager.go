// Package cert provides certificate management for MITM proxying.
package cert

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

// Manager manages CA certificates for MITM proxying.
type Manager struct {
	certDir string
	ca      *tls.Certificate
}

// NewManager creates a new certificate manager.
func NewManager(certDir string) (*Manager, error) {
	certDir = filepath.Clean(certDir)
	if err := os.MkdirAll(certDir, 0750); err != nil {
		return nil, fmt.Errorf("create cert dir: %w", err)
	}

	m := &Manager{certDir: certDir}

	ca, err := m.getOrCreateCA()
	if err != nil {
		return nil, err
	}
	m.ca = ca

	return m, nil
}

// GetCA returns the CA certificate.
func (m *Manager) GetCA() *tls.Certificate {
	return m.ca
}

// GetCACertPath returns the path to the CA certificate file.
func (m *Manager) GetCACertPath() string {
	return filepath.Join(m.certDir, "ca.crt")
}

func (m *Manager) getOrCreateCA() (*tls.Certificate, error) {
	certPath := filepath.Join(m.certDir, "ca.crt")
	keyPath := filepath.Join(m.certDir, "ca.key")

	// Try to load existing CA
	if cert, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		return &cert, nil
	}

	// Generate new CA
	return m.generateCA(certPath, keyPath)
}

func (m *Manager) generateCA(certPath, keyPath string) (*tls.Certificate, error) {
	// Clean paths to satisfy gosec G304
	certPath = filepath.Clean(certPath)
	keyPath = filepath.Clean(keyPath)

	// Generate private key
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generate key: %w", err)
	}

	// Generate serial number
	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("generate serial: %w", err)
	}

	// Create certificate template
	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"Discobot Proxy"},
			CommonName:   "Discobot Proxy CA",
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour), // 10 years
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
	}

	// Create certificate
	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &privateKey.PublicKey, privateKey)
	if err != nil {
		return nil, fmt.Errorf("create certificate: %w", err)
	}

	// Save certificate
	certFile, err := os.Create(certPath)
	if err != nil {
		return nil, fmt.Errorf("create cert file: %w", err)
	}
	defer func() { _ = certFile.Close() }()

	if err := pem.Encode(certFile, &pem.Block{Type: "CERTIFICATE", Bytes: certDER}); err != nil {
		return nil, fmt.Errorf("encode cert: %w", err)
	}

	// Save private key
	keyFile, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return nil, fmt.Errorf("create key file: %w", err)
	}
	defer func() { _ = keyFile.Close() }()

	keyDER := x509.MarshalPKCS1PrivateKey(privateKey)
	if err := pem.Encode(keyFile, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: keyDER}); err != nil {
		return nil, fmt.Errorf("encode key: %w", err)
	}

	// Parse and return the certificate
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, fmt.Errorf("load generated cert: %w", err)
	}

	return &cert, nil
}
