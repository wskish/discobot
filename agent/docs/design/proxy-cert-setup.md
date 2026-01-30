# Proxy CA Certificate - Automatic Setup

## Overview

The agent automatically generates a CA certificate for the proxy and installs it in the system trust store during container startup. This enables transparent HTTPS interception without certificate warnings.

## Why This Is Needed

For the proxy to cache HTTPS traffic (like Docker registry pulls), it must perform "Man-in-the-Middle" (MITM) interception:

1. Client makes HTTPS request to `registry-1.docker.io`
2. Proxy intercepts the connection
3. Proxy generates a fake certificate for `registry-1.docker.io` **signed by its CA**
4. Proxy forwards the request to the real server
5. Client verifies the fake certificate using the **trusted CA**

Without the CA in the system trust store, clients would see certificate errors and refuse to connect.

## Implementation

### Step 1: Certificate Generation

**Location**: `agent/cmd/agent/main.go` - `setupProxyCertificate()` and `generateCACertificate()`

**Process**:
```go
// Check if certificate already exists
if _, err := os.Stat("/.data/proxy/certs/ca.crt"); err == nil {
    fmt.Printf("Certificate exists, reusing...\n")
    return installCertificateInSystemTrust(certPath)
}

// Generate using Go crypto libraries
privateKey, _ := rsa.GenerateKey(rand.Reader, 2048)
serialNumber, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))

template := x509.Certificate{
    SerialNumber: serialNumber,
    Subject: pkix.Name{
        Organization: []string{"Discobot Proxy"},
        CommonName:   "Discobot Proxy CA",
    },
    NotBefore:             time.Now(),
    NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
    KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
    ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
    BasicConstraintsValid: true,
    IsCA:                  true,
    MaxPathLen:            0,
    MaxPathLenZero:        true,
    // SANs for localhost
    DNSNames:    []string{"localhost"},
    IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
}

certDER, _ := x509.CreateCertificate(rand.Reader, &template, &template, &privateKey.PublicKey, privateKey)

// Save as PEM files with appropriate permissions
// ca.crt: mode 0644, ca.key: mode 0600
```

**Key Details**:
- **Implementation**: Pure Go using `crypto/x509` and `crypto/rsa` (no external dependencies)
- **Subject**: `O=Discobot Proxy, CN=Discobot Proxy CA`
- **SANs (Subject Alternative Names)**: `localhost`, `127.0.0.1`, `::1` (for proper proxy identification)
- **Validity**: 10 years (3650 days)
- **Key Size**: 2048-bit RSA
- **Storage**: `/.data/proxy/certs/` (persistent if `/.data` is a volume)
- **Reuse**: Existing certificates are detected and reused

### Step 2: System Trust Installation

**Location**: `agent/cmd/agent/main.go` - `installCertificateInSystemTrust()`

**Detection Logic**:
```go
// Try Debian/Ubuntu/Alpine style first
if _, err := exec.LookPath("update-ca-certificates"); err == nil {
    return installCertDebianStyle(certPath)
}

// Try Fedora/RHEL style second
if _, err := exec.LookPath("update-ca-trust"); err == nil {
    return installCertFedoraStyle(certPath)
}

// No tool found - warn but continue
fmt.Printf("warning: no certificate update tool found\n")
return nil
```

### Step 3a: Debian/Ubuntu/Alpine Installation

**Location**: `installCertDebianStyle()`

**Process**:
```bash
# Copy certificate to standard location
cp /.data/proxy/certs/ca.crt /usr/local/share/ca-certificates/discobot-proxy-ca.crt

# Update system trust store
update-ca-certificates
```

**What happens**:
- Certificate is added to `/etc/ssl/certs/ca-certificates.crt` (bundle)
- All programs using OpenSSL/GnuTLS automatically trust it
- Docker, curl, wget, Python requests, Node.js https, etc. all work

### Step 3b: Fedora/RHEL/CentOS Installation

**Location**: `installCertFedoraStyle()`

**Process**:
```bash
# Copy certificate to standard location
cp /.data/proxy/certs/ca.crt /etc/pki/ca-trust/source/anchors/discobot-proxy-ca.crt

# Update system trust store
update-ca-trust extract
```

**What happens**:
- Certificate is processed into various trust bundle formats
- Trust bundles updated: `/etc/pki/ca-trust/extracted/`
- All programs using NSS/OpenSSL automatically trust it

## Startup Flow Integration

The certificate setup happens during container initialization:

```
Container Startup
    ↓
[Steps 1-5: Home, workspace, filesystem setup]
    ↓
Step 5b: Setup proxy config (from workspace or defaults)
    ↓
Step 5c: Generate CA certificate & install in system trust  ← THIS IS NEW
    ├─ Check if /.data/proxy/certs/ca.crt exists
    ├─ Generate with OpenSSL if not found
    ├─ Detect OS (Debian/Fedora/Alpine/other)
    ├─ Copy to system trust directory
    └─ Run update command (update-ca-certificates or update-ca-trust)
    ↓
Step 6: Start proxy daemon
    ├─ Proxy loads CA from /.data/proxy/certs/
    └─ Proxy can now sign fake certificates for HTTPS MITM
    ↓
Step 7: Start Docker daemon (with proxy env vars)
    └─ Docker trusts proxy CA, no certificate errors
    ↓
Step 8: Start agent-api (with proxy env vars)
    └─ Agent API trusts proxy CA, no certificate errors
```

## Benefits

### Before (Manual Trust)
```
❌ User must manually extract CA cert from container
❌ User must manually install in host system
❌ Agent processes see certificate errors for HTTPS
❌ Docker pull may fail or bypass proxy
❌ Complex setup for developers
```

### After (Automatic Trust)
```
✅ CA certificate auto-generated on first run
✅ Automatically installed in container system trust
✅ All processes in container trust the CA
✅ Docker pulls work seamlessly through proxy
✅ HTTPS caching works out of the box
✅ Zero configuration required
```

## Security Considerations

### Private Key Protection
- Key file: `/.data/proxy/certs/ca.key`
- Permissions: `0600` (owner read/write only)
- Owner: root (agent runs as PID 1)
- Not exposed outside container

### Certificate Trust Scope
- **Container only**: Trust is limited to the container's system trust store
- **Host unaffected**: Host system trust store is not modified
- **Volume persistence**: If `/.data` is a volume, same CA reused across restarts

### Certificate Rotation
- **10-year validity**: Long enough to avoid frequent rotation
- **Manual rotation**: Delete `/.data/proxy/certs/ca.{crt,key}` and restart container
- **Automatic regeneration**: New certificate generated if files deleted

## Testing

### Verify Certificate Generation
```bash
# Enter running container
docker exec -it <container> bash

# Check certificate exists
ls -la /.data/proxy/certs/
# Should show:
# -rw-r--r-- 1 root root 1188 ... ca.crt
# -rw------- 1 root root 1675 ... ca.key

# View certificate details
openssl x509 -in /.data/proxy/certs/ca.crt -text -noout
# Should show:
#   Subject: O = Discobot Proxy, CN = Discobot Proxy CA
#   Validity: Not After : <10 years from generation>
```

### Verify System Trust (Debian/Ubuntu/Alpine)
```bash
# Check certificate in trust directory
ls -la /usr/local/share/ca-certificates/discobot-proxy-ca.crt

# Check certificate in bundle
grep -q "Discobot Proxy" /etc/ssl/certs/ca-certificates.crt && echo "FOUND"
```

### Verify System Trust (Fedora/RHEL)
```bash
# Check certificate in trust directory
ls -la /etc/pki/ca-trust/source/anchors/discobot-proxy-ca.crt

# Check trust bundles updated
ls -la /etc/pki/ca-trust/extracted/
```

### Verify HTTPS Works Through Proxy
```bash
# Set proxy environment
export HTTP_PROXY=http://localhost:17080
export HTTPS_PROXY=http://localhost:17080

# Test HTTPS request (should work without certificate errors)
curl -v https://registry-1.docker.io/v2/
# Should see "HTTP/1.1 200 OK" or "HTTP/1.1 401 Unauthorized" (auth required)
# Should NOT see certificate errors

# Test Docker pull through proxy
docker pull ubuntu:latest
# Should work without certificate warnings
```

## Troubleshooting

### Certificate Not Generated
**Symptom**: No certificate at `/.data/proxy/certs/ca.crt`

**Possible causes**:
- Permission issues creating `/.data/proxy/certs/`
- Startup step skipped due to earlier error
- Go crypto library error (RSA key generation or certificate creation)

**Solution**: Check agent logs for errors during Step 5c

### Certificate Not Trusted
**Symptom**: Certificate errors when making HTTPS requests through proxy

**Possible causes**:
- Certificate update tool not found (unsupported OS)
- Update command failed (check logs)
- Program using custom trust store (bypassing system)

**Debug commands**:
```bash
# Check which update tool is available
which update-ca-certificates update-ca-trust

# Manually run update
update-ca-certificates         # Debian/Ubuntu/Alpine
update-ca-trust extract        # Fedora/RHEL

# Check if certificate is in bundle
grep "Discobot Proxy" /etc/ssl/certs/ca-certificates.crt
```

### Certificate Generation Fails
**Symptom**: Agent logs show errors like "generate RSA key" or "create certificate"

**Possible causes**:
- Insufficient entropy for random number generation (rare in containers)
- Disk write failure (out of space or permissions)

**Solution**:
- Check available disk space: `df -h /.data`
- Verify directory permissions: `ls -ld /.data/proxy/certs`
- Check dmesg for kernel-level errors

## Files Modified

### Agent Code
- **`agent/cmd/agent/main.go`**:
  - Added crypto imports: `crypto/rand`, `crypto/rsa`, `crypto/x509`, `crypto/x509/pkix`, `encoding/pem`, `math/big`
  - `setupProxyCertificate()` - Main orchestration
  - `generateCACertificate()` - Go crypto certificate generation with localhost SANs
  - `installCertificateInSystemTrust()` - OS detection and delegation
  - `installCertDebianStyle()` - Debian/Ubuntu/Alpine installation
  - `installCertFedoraStyle()` - Fedora/RHEL installation
  - Modified `run()` to call `setupProxyCertificate()` before starting proxy

### Dockerfile
- **`Dockerfile`**: No changes needed - certificate generation uses pure Go (no external dependencies)

### Documentation
- **`PROXY_INTEGRATION.md`**: Added "CA Certificate Generation & System Trust" section
- **`PROXY_IMPLEMENTATION_SUMMARY.md`**: Updated startup flow and key changes
- **`PROXY_CERT_SETUP.md`**: This file (detailed implementation guide)

## References

- [OpenSSL Certificate Generation](https://www.openssl.org/docs/man3.0/man1/openssl-req.html)
- [Debian CA Certificates](https://wiki.debian.org/Self-Signed_Certificate)
- [RHEL CA Trust](https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/8/html/security_hardening/using-shared-system-certificates_security-hardening)
- [Alpine CA Certificates](https://wiki.alpinelinux.org/wiki/Setting_up_a_Certificate_Authority)
