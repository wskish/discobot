# VZ Image Downloader Manual Tests

This directory contains manual tests for the VZ image downloader that can be run during development to verify functionality.

## Running the Tests

### Prerequisites
- **Any platform** (Linux, macOS, Windows) - The downloader tests are platform-independent
- Internet connection to download images from container registry
- **Note**: While the tests run on any platform, VZ VMs can only be created on macOS ARM64

### Method 1: Using Environment Variable (Recommended)

```bash
cd server
VZ_MANUAL_TEST=1 go test -v ./internal/sandbox/vz -run TestImageDownloaderManual
```

This works on **any platform** (Linux, macOS, Windows).

### Method 2: Using the Helper Script (macOS only)

```bash
cd server
./internal/sandbox/vz/run_manual_tests.sh
```

**Note**: The helper script validates platform requirements (macOS ARM64), but the test itself runs on any platform when using Method 1.

## What the Tests Do

### TestImageDownloaderManual

This test verifies the complete download workflow:

1. **DownloadFromRegistry**:
   - Downloads the VZ image from the configured registry
   - Shows progress updates every 2 seconds
   - Verifies files are extracted correctly
   - Checks file sizes are reasonable
   - Validates manifest.json is created

2. **VerifyCache**:
   - Tests that subsequent downloads use the cache
   - Verifies cache lookup is fast (< 5 seconds)
   - Confirms same files are returned

3. **DigestStability**:
   - Ensures digest computation is deterministic
   - Multiple downloaders for the same image produce the same cache key

### TestImageDownloaderInvalidImage

Tests error handling for invalid scenarios:

1. **InvalidImageRef**: Malformed image reference
2. **NonexistentImage**: Valid format but image doesn't exist

## Customizing the Test

### Use a Different Image

Set the `VZ_TEST_IMAGE_REF` environment variable:

```bash
VZ_TEST_IMAGE_REF=ghcr.io/myorg/custom-vz:latest \
VZ_MANUAL_TEST=1 \
go test -v ./internal/sandbox/vz -run TestImageDownloaderManual
```

### Run Error Tests Only

```bash
VZ_MANUAL_TEST=1 go test -v ./internal/sandbox/vz -run TestImageDownloaderInvalidImage
```

## Expected Output

Successful test output should look like:

```
=== RUN   TestImageDownloaderManual
    image_downloader_manual_test.go:35: Test directory: /tmp/vz-downloader-test-123456
=== RUN   TestImageDownloaderManual/DownloadFromRegistry
    image_downloader_manual_test.go:42: Downloading image: ghcr.io/obot-platform/discobot-vz:main
    image_downloader_manual_test.go:58: Progress: State=downloading
    image_downloader_manual_test.go:55: Progress: 15.2% (27305984/179456123 bytes) - State: downloading
    image_downloader_manual_test.go:55: Progress: 47.8% (85762048/179456123 bytes) - State: downloading
    image_downloader_manual_test.go:55: Progress: 89.3% (160234496/179456123 bytes) - State: extracting
    image_downloader_manual_test.go:80: Kernel path: /tmp/vz-downloader-test-123456/images/sha256-abc123/vmlinuz
    image_downloader_manual_test.go:81: Base disk path: /tmp/vz-downloader-test-123456/images/sha256-abc123/discobot-rootfs.squashfs
    image_downloader_manual_test.go:96: Kernel size: 14.52 MB
    image_downloader_manual_test.go:97: Disk size: 164.23 MB
    image_downloader_manual_test.go:112: Manifest path: /tmp/vz-downloader-test-123456/images/sha256-abc123/manifest.json
=== RUN   TestImageDownloaderManual/VerifyCache
    image_downloader_manual_test.go:121: Creating second downloader to test cache...
    image_downloader_manual_test.go:133: Cache lookup took: 234.5µs
    image_downloader_manual_test.go:143: Cached kernel path: /tmp/vz-downloader-test-123456/images/sha256-abc123/vmlinuz
    image_downloader_manual_test.go:144: Cached disk path: /tmp/vz-downloader-test-123456/images/sha256-abc123/discobot-rootfs.squashfs
=== RUN   TestImageDownloaderManual/DigestStability
    image_downloader_manual_test.go:176: Stable digest: sha256-abc123
    image_downloader_manual_test.go:179: ✓ All manual tests passed!
    image_downloader_manual_test.go:180: Test artifacts in: /tmp/vz-downloader-test-123456
--- PASS: TestImageDownloaderManual (45.23s)
```

## Troubleshooting

### Test is Skipped

If you see:
```
--- SKIP: TestImageDownloaderManual (0.00s)
    image_downloader_manual_test.go:27: Skipping manual test. Set VZ_MANUAL_TEST=1 to run.
```

Make sure to set `VZ_MANUAL_TEST=1` environment variable.

### Test Not Found (Fixed!)

The tests now run on all platforms! Previous versions had `//go:build darwin` constraints that have been removed since the image downloader is pure Go and platform-independent.

### Download Timeout

If the download takes longer than 10 minutes, the test will timeout. You can modify the timeout in the test file if needed for slower connections.

### Registry Authentication

If you need to authenticate with the registry, ensure your Docker credentials are configured:

```bash
docker login ghcr.io
```

The `go-containerregistry` library will automatically use Docker's credential store.

## Integration with CI/CD

These tests are marked as manual and won't run in CI/CD by default. To run them in CI on macOS runners:

```yaml
- name: Run VZ Manual Tests
  if: runner.os == 'macOS' && runner.arch == 'ARM64'
  env:
    VZ_MANUAL_TEST: 1
  run: |
    cd server
    go test -v ./internal/sandbox/vz -run TestImageDownloaderManual
```
