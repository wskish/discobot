package vz

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

// DownloadState represents the current state of the image download process.
type DownloadState int

const (
	DownloadStateNotStarted DownloadState = iota
	DownloadStateDownloading
	DownloadStateExtracting
	DownloadStateReady
	DownloadStateFailed
)

func (s DownloadState) String() string {
	switch s {
	case DownloadStateNotStarted:
		return "not_started"
	case DownloadStateDownloading:
		return "downloading"
	case DownloadStateExtracting:
		return "extracting"
	case DownloadStateReady:
		return "ready"
	case DownloadStateFailed:
		return "failed"
	default:
		return "unknown"
	}
}

// DownloadConfig contains configuration for downloading VZ images.
type DownloadConfig struct {
	ImageRef string // e.g., "ghcr.io/obot-platform/discobot-vz:main"
	DataDir  string // Storage location for extracted files
}

// DownloadProgress tracks the progress of an image download.
type DownloadProgress struct {
	State           DownloadState `json:"state"`
	BytesDownloaded int64         `json:"bytes_downloaded"`
	TotalBytes      int64         `json:"total_bytes"`
	CurrentLayer    string        `json:"current_layer"`
	Error           string        `json:"error,omitempty"`
	StartedAt       time.Time     `json:"started_at"`
	CompletedAt     time.Time     `json:"completed_at,omitempty"`
}

// ImageDownloader manages async download of VZ images from container registry.
type ImageDownloader struct {
	cfg        DownloadConfig
	state      DownloadState
	stateMu    sync.RWMutex
	progress   DownloadProgress
	progressMu sync.RWMutex
	doneCh     chan struct{}

	// Extracted paths (populated after successful download)
	kernelPath   string
	baseDiskPath string
}

// NewImageDownloader creates a new image downloader.
func NewImageDownloader(cfg DownloadConfig) *ImageDownloader {
	return &ImageDownloader{
		cfg:    cfg,
		state:  DownloadStateNotStarted,
		doneCh: make(chan struct{}),
		progress: DownloadProgress{
			State: DownloadStateNotStarted,
		},
	}
}

// Start begins the async download process.
// It checks if the image is already cached before downloading.
func (d *ImageDownloader) Start(ctx context.Context) error {
	d.updateState(DownloadStateDownloading)
	d.updateProgress(func(p *DownloadProgress) {
		p.State = DownloadStateDownloading
		p.StartedAt = time.Now()
	})

	// Check if already cached
	if cached, kernelPath, baseDiskPath := d.checkCache(); cached {
		log.Printf("VZ images already cached: kernel=%s, disk=%s", kernelPath, baseDiskPath)
		d.kernelPath = kernelPath
		d.baseDiskPath = baseDiskPath
		d.updateState(DownloadStateReady)
		d.updateProgress(func(p *DownloadProgress) {
			p.State = DownloadStateReady
			p.CompletedAt = time.Now()
		})
		close(d.doneCh)
		return nil
	}

	// Download and extract
	if err := d.download(ctx); err != nil {
		d.updateState(DownloadStateFailed)
		d.updateProgress(func(p *DownloadProgress) {
			p.State = DownloadStateFailed
			p.Error = err.Error()
		})
		close(d.doneCh)
		return err
	}

	d.updateState(DownloadStateReady)
	d.updateProgress(func(p *DownloadProgress) {
		p.State = DownloadStateReady
		p.CompletedAt = time.Now()
	})
	close(d.doneCh)
	return nil
}

// Status returns the current download status.
func (d *ImageDownloader) Status() DownloadProgress {
	d.progressMu.RLock()
	defer d.progressMu.RUnlock()
	return d.progress
}

// Wait blocks until the download completes or context is cancelled.
func (d *ImageDownloader) Wait(ctx context.Context) error {
	select {
	case <-d.doneCh:
		d.stateMu.RLock()
		state := d.state
		d.stateMu.RUnlock()
		if state == DownloadStateFailed {
			d.progressMu.RLock()
			err := d.progress.Error
			d.progressMu.RUnlock()
			return fmt.Errorf("download failed: %s", err)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// GetPaths returns the paths to the extracted kernel and base disk.
// Returns ok=false if the download is not complete.
func (d *ImageDownloader) GetPaths() (kernelPath, baseDiskPath string, ok bool) {
	d.stateMu.RLock()
	defer d.stateMu.RUnlock()
	if d.state != DownloadStateReady {
		return "", "", false
	}
	return d.kernelPath, d.baseDiskPath, true
}

// checkCache verifies if the image is already cached locally.
func (d *ImageDownloader) checkCache() (cached bool, kernelPath, baseDiskPath string) {
	digest := d.computeDigest()
	cacheDir := filepath.Join(d.cfg.DataDir, "images", digest)

	kernelPath = filepath.Join(cacheDir, "vmlinuz")
	baseDiskPath = filepath.Join(cacheDir, "discobot-rootfs.squashfs")

	// Check if both files exist and have reasonable sizes
	kernelInfo, kernelErr := os.Stat(kernelPath)
	diskInfo, diskErr := os.Stat(baseDiskPath)

	if kernelErr == nil && diskErr == nil && kernelInfo.Size() > 0 && diskInfo.Size() > 0 {
		log.Printf("Found cached VZ images in %s", cacheDir)
		return true, kernelPath, baseDiskPath
	}

	return false, "", ""
}

// computeDigest creates a stable digest from the image reference for cache key.
func (d *ImageDownloader) computeDigest() string {
	h := sha256.New()
	h.Write([]byte(d.cfg.ImageRef))
	return fmt.Sprintf("sha256-%x", h.Sum(nil))[:19] // Short hash for filesystem
}

// download pulls the image from the registry and extracts the kernel and disk files.
func (d *ImageDownloader) download(ctx context.Context) error {
	log.Printf("Downloading VZ images from %s", d.cfg.ImageRef)

	// Parse image reference
	ref, err := name.ParseReference(d.cfg.ImageRef)
	if err != nil {
		return fmt.Errorf("invalid image reference %s: %w", d.cfg.ImageRef, err)
	}

	// Fetch image manifest with context for cancellation support
	img, err := remote.Image(ref, remote.WithContext(ctx))
	if err != nil {
		return fmt.Errorf("failed to fetch image: %w", err)
	}

	// Get image size
	manifest, err := img.Manifest()
	if err != nil {
		return fmt.Errorf("failed to get manifest: %w", err)
	}

	var totalBytes int64
	for _, layer := range manifest.Layers {
		totalBytes += layer.Size
	}

	d.updateProgress(func(p *DownloadProgress) {
		p.TotalBytes = totalBytes
	})

	// Get layers
	layers, err := img.Layers()
	if err != nil {
		return fmt.Errorf("failed to get layers: %w", err)
	}

	// Create temp directory for extraction
	digest := d.computeDigest()
	cacheDir := filepath.Join(d.cfg.DataDir, "images", digest)
	tempDir := cacheDir + ".tmp"

	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return fmt.Errorf("failed to create temp directory: %w", err)
	}
	defer os.RemoveAll(tempDir) // Clean up temp dir on error

	// Extract files from layers
	d.updateState(DownloadStateExtracting)
	d.updateProgress(func(p *DownloadProgress) {
		p.State = DownloadStateExtracting
	})

	var kernelFound, diskFound bool
	var bytesDownloaded int64

	for i, layer := range layers {
		layerDigest, err := layer.Digest()
		if err != nil {
			return fmt.Errorf("failed to get layer digest: %w", err)
		}

		d.updateProgress(func(p *DownloadProgress) {
			p.CurrentLayer = layerDigest.String()
		})

		log.Printf("Extracting layer %d/%d: %s", i+1, len(layers), layerDigest)

		// Get layer reader
		rc, err := layer.Compressed()
		if err != nil {
			return fmt.Errorf("failed to get layer reader: %w", err)
		}

		// Uncompress layer
		uncompressed, err := layer.Uncompressed()
		if err != nil {
			rc.Close()
			return fmt.Errorf("failed to uncompress layer: %w", err)
		}

		// Extract files from tar
		if err := d.extractFiles(uncompressed, tempDir, &kernelFound, &diskFound); err != nil {
			rc.Close()
			uncompressed.Close()
			return fmt.Errorf("failed to extract files from layer: %w", err)
		}

		uncompressed.Close()
		rc.Close()

		// Update progress
		size, _ := layer.Size()
		bytesDownloaded += size
		d.updateProgress(func(p *DownloadProgress) {
			p.BytesDownloaded = bytesDownloaded
		})
	}

	// Verify we found both files
	if !kernelFound {
		return fmt.Errorf("kernel file (vmlinuz) not found in image")
	}
	if !diskFound {
		return fmt.Errorf("disk file (discobot-rootfs.squashfs) not found in image")
	}

	// Write metadata
	metadata := map[string]interface{}{
		"image_ref":   d.cfg.ImageRef,
		"digest":      digest,
		"pulled_at":   time.Now().Format(time.RFC3339),
		"total_bytes": totalBytes,
	}
	metadataJSON, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal metadata: %w", err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "manifest.json"), metadataJSON, 0644); err != nil {
		return fmt.Errorf("failed to write metadata: %w", err)
	}

	// Atomic rename from temp to final directory
	if err := os.Rename(tempDir, cacheDir); err != nil {
		return fmt.Errorf("failed to finalize cache directory: %w", err)
	}

	d.kernelPath = filepath.Join(cacheDir, "vmlinuz")
	d.baseDiskPath = filepath.Join(cacheDir, "discobot-rootfs.squashfs")

	log.Printf("VZ images extracted successfully: kernel=%s, disk=%s", d.kernelPath, d.baseDiskPath)
	return nil
}

// extractFiles extracts vmlinuz and discobot-rootfs.squashfs from a tar stream.
func (d *ImageDownloader) extractFiles(r io.Reader, destDir string, kernelFound, diskFound *bool) error {
	tr := tar.NewReader(r)

	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		// Look for /vmlinuz or /discobot-rootfs.squashfs
		if header.Name == "vmlinuz" || strings.HasSuffix(header.Name, "/vmlinuz") {
			destPath := filepath.Join(destDir, "vmlinuz")
			if err := d.writeFile(tr, destPath, header.Mode); err != nil {
				return fmt.Errorf("failed to write kernel: %w", err)
			}
			*kernelFound = true
			log.Printf("Extracted kernel: %s (%d bytes)", header.Name, header.Size)
		} else if header.Name == "discobot-rootfs.squashfs" || strings.HasSuffix(header.Name, "/discobot-rootfs.squashfs") {
			destPath := filepath.Join(destDir, "discobot-rootfs.squashfs")
			if err := d.writeFile(tr, destPath, header.Mode); err != nil {
				return fmt.Errorf("failed to write disk: %w", err)
			}
			*diskFound = true
			log.Printf("Extracted disk: %s (%d bytes)", header.Name, header.Size)
		}
	}

	return nil
}

// writeFile writes a file from the tar reader to disk.
func (d *ImageDownloader) writeFile(r io.Reader, destPath string, mode int64) error {
	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(mode))
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := io.Copy(f, r); err != nil {
		return err
	}

	return nil
}

// updateState updates the download state thread-safely.
func (d *ImageDownloader) updateState(state DownloadState) {
	d.stateMu.Lock()
	d.state = state
	d.stateMu.Unlock()
}

// updateProgress updates the download progress thread-safely.
func (d *ImageDownloader) updateProgress(fn func(*DownloadProgress)) {
	d.progressMu.Lock()
	fn(&d.progress)
	d.progressMu.Unlock()
}
