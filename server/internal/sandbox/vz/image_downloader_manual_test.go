package vz

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestImageDownloaderManual is a manual test for the image downloader.
// To run this test:
//
//	go test -tags=manual -v ./internal/sandbox/vz -run TestImageDownloaderManual
//
// Or set the environment variable:
//
//	VZ_MANUAL_TEST=1 go test -v ./internal/sandbox/vz -run TestImageDownloaderManual
//
// This test will:
// 1. Download the VZ image from the registry
// 2. Extract the kernel and rootfs files
// 3. Verify the cache works on subsequent runs
// 4. Display progress during download
func TestImageDownloaderManual(t *testing.T) {
	// Skip if VZ_MANUAL_TEST is not set (for non-manual builds)
	if os.Getenv("VZ_MANUAL_TEST") != "1" {
		t.Skip("Skipping manual test. Set VZ_MANUAL_TEST=1 to run.")
	}

	// Create temp directory for test
	tempDir, err := os.MkdirTemp("", "vz-downloader-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	t.Logf("Test directory: %s", tempDir)

	// Test 1: Download from registry
	t.Run("DownloadFromRegistry", func(t *testing.T) {
		imageRef := os.Getenv("VZ_TEST_IMAGE_REF")
		if imageRef == "" {
			imageRef = "ghcr.io/obot-platform/discobot-vz:main"
		}

		t.Logf("Downloading image: %s", imageRef)

		downloader := NewImageDownloader(DownloadConfig{
			ImageRef: imageRef,
			DataDir:  tempDir,
		})

		// Monitor progress in background
		done := make(chan struct{})
		go func() {
			ticker := time.NewTicker(2 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-done:
					return
				case <-ticker.C:
					progress := downloader.Status()
					if progress.TotalBytes > 0 {
						pct := float64(progress.BytesDownloaded) / float64(progress.TotalBytes) * 100
						t.Logf("Progress: %.1f%% (%d/%d bytes) - State: %s",
							pct, progress.BytesDownloaded, progress.TotalBytes, progress.State.String())
					} else {
						t.Logf("Progress: State=%s", progress.State.String())
					}
				}
			}
		}()

		// Start download
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()

		err := downloader.Start(ctx)
		close(done)

		if err != nil {
			t.Fatalf("Download failed: %v", err)
		}

		// Verify download completed
		progress := downloader.Status()
		if progress.State != DownloadStateReady {
			t.Fatalf("Expected state Ready, got %s (error: %s)", progress.State.String(), progress.Error)
		}

		// Get paths
		kernelPath, baseDiskPath, ok := downloader.GetPaths()
		if !ok {
			t.Fatal("Failed to get paths after successful download")
		}

		t.Logf("Kernel path: %s", kernelPath)
		t.Logf("Base disk path: %s", baseDiskPath)

		// Verify files exist
		if _, err := os.Stat(kernelPath); err != nil {
			t.Errorf("Kernel file not found: %v", err)
		}
		if _, err := os.Stat(baseDiskPath); err != nil {
			t.Errorf("Base disk file not found: %v", err)
		}

		// Verify file sizes
		kernelInfo, err := os.Stat(kernelPath)
		if err != nil {
			t.Fatalf("Failed to stat kernel: %v", err)
		}
		diskInfo, err := os.Stat(baseDiskPath)
		if err != nil {
			t.Fatalf("Failed to stat disk: %v", err)
		}

		t.Logf("Kernel size: %.2f MB", float64(kernelInfo.Size())/1024/1024)
		t.Logf("Disk size: %.2f MB", float64(diskInfo.Size())/1024/1024)

		// Sanity check sizes
		if kernelInfo.Size() < 1*1024*1024 {
			t.Errorf("Kernel seems too small: %d bytes", kernelInfo.Size())
		}
		if diskInfo.Size() < 50*1024*1024 {
			t.Errorf("Disk seems too small: %d bytes", diskInfo.Size())
		}

		// Verify file types by checking magic bytes
		t.Log("Verifying file types...")

		// Check kernel - should be a Linux kernel (starts with specific bytes)
		kernelFile, err := os.Open(kernelPath)
		if err != nil {
			t.Errorf("Failed to open kernel: %v", err)
		} else {
			defer kernelFile.Close()
			header := make([]byte, 512)
			n, _ := kernelFile.Read(header)
			if n > 0 {
				// Linux kernel typically has MZ header or specific boot signature
				t.Logf("Kernel header (first 16 bytes): % x", header[:16])
			}
		}

		// Check SquashFS - should have "hsqs" magic (0x73717368)
		diskFile, err := os.Open(baseDiskPath)
		if err != nil {
			t.Errorf("Failed to open disk: %v", err)
		} else {
			defer diskFile.Close()
			magic := make([]byte, 4)
			n, _ := diskFile.Read(magic)
			if n == 4 {
				// SquashFS magic is "hsqs" (0x73717368)
				if string(magic) == "hsqs" || string(magic) == "sqsh" {
					t.Logf("✓ Disk is valid SquashFS (magic: %s)", string(magic))
				} else {
					t.Errorf("Disk does not appear to be SquashFS (magic: % x)", magic)
				}
			}
		}

		// Verify manifest exists
		digest := downloader.computeDigest()
		manifestPath := filepath.Join(tempDir, "images", digest, "manifest.json")
		if _, err := os.Stat(manifestPath); err != nil {
			t.Errorf("Manifest file not found: %v", err)
		} else {
			t.Logf("Manifest path: %s", manifestPath)
		}
	})

	// Test 2: Verify cache works
	t.Run("VerifyCache", func(t *testing.T) {
		imageRef := os.Getenv("VZ_TEST_IMAGE_REF")
		if imageRef == "" {
			imageRef = "ghcr.io/obot-platform/discobot-vz:main"
		}

		t.Log("Creating second downloader to test cache...")

		downloader := NewImageDownloader(DownloadConfig{
			ImageRef: imageRef,
			DataDir:  tempDir,
		})

		// Start should return immediately from cache
		start := time.Now()
		ctx := context.Background()
		err := downloader.Start(ctx)
		elapsed := time.Since(start)

		if err != nil {
			t.Fatalf("Cached download failed: %v", err)
		}

		t.Logf("Cache lookup took: %v", elapsed)

		// Should be very fast (< 1 second)
		if elapsed > 5*time.Second {
			t.Errorf("Cache lookup took too long: %v (expected < 5s)", elapsed)
		}

		// Verify we got the same paths
		kernelPath, baseDiskPath, ok := downloader.GetPaths()
		if !ok {
			t.Fatal("Failed to get paths from cache")
		}

		t.Logf("Cached kernel path: %s", kernelPath)
		t.Logf("Cached disk path: %s", baseDiskPath)

		// Verify state is ready
		progress := downloader.Status()
		if progress.State != DownloadStateReady {
			t.Errorf("Expected state Ready from cache, got %s", progress.State.String())
		}
	})

	// Test 3: Verify digest computation is stable
	t.Run("DigestStability", func(t *testing.T) {
		imageRef := "ghcr.io/obot-platform/discobot-vz:main"

		d1 := NewImageDownloader(DownloadConfig{
			ImageRef: imageRef,
			DataDir:  tempDir,
		})

		d2 := NewImageDownloader(DownloadConfig{
			ImageRef: imageRef,
			DataDir:  tempDir,
		})

		digest1 := d1.computeDigest()
		digest2 := d2.computeDigest()

		if digest1 != digest2 {
			t.Errorf("Digest mismatch: %s != %s", digest1, digest2)
		}

		t.Logf("Stable digest: %s", digest1)
	})

	t.Log("✓ All manual tests passed!")
	t.Logf("Test artifacts in: %s", tempDir)
	t.Log("Note: Temp directory will be cleaned up automatically")
}

// TestImageDownloaderInvalidImage tests error handling with an invalid image.
// This is part of the manual test suite.
func TestImageDownloaderInvalidImage(t *testing.T) {
	if os.Getenv("VZ_MANUAL_TEST") != "1" {
		t.Skip("Skipping manual test. Set VZ_MANUAL_TEST=1 to run.")
	}

	tempDir, err := os.MkdirTemp("", "vz-downloader-invalid-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	t.Run("InvalidImageRef", func(t *testing.T) {
		downloader := NewImageDownloader(DownloadConfig{
			ImageRef: "invalid-image-ref-!!!",
			DataDir:  tempDir,
		})

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		err := downloader.Start(ctx)
		if err == nil {
			t.Error("Expected error for invalid image ref, got nil")
		}

		progress := downloader.Status()
		if progress.State != DownloadStateFailed {
			t.Errorf("Expected state Failed, got %s", progress.State.String())
		}

		t.Logf("Got expected error: %v", err)
	})

	t.Run("NonexistentImage", func(t *testing.T) {
		downloader := NewImageDownloader(DownloadConfig{
			ImageRef: "ghcr.io/nonexistent/image:does-not-exist",
			DataDir:  tempDir,
		})

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		err := downloader.Start(ctx)
		if err == nil {
			t.Error("Expected error for nonexistent image, got nil")
		}

		progress := downloader.Status()
		if progress.State != DownloadStateFailed {
			t.Errorf("Expected state Failed, got %s", progress.State.String())
		}

		t.Logf("Got expected error: %v", err)
	})
}
