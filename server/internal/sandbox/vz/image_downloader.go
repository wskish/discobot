package vz

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/klauspost/compress/zstd"
	"github.com/ulikunitz/xz"
	"github.com/ulikunitz/xz/lzma"
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

	// Resolve the correct platform for multi-arch images.
	// VZ only runs on macOS (Apple Silicon = linux/arm64 guest).
	platform := v1.Platform{
		OS:           "linux",
		Architecture: runtime.GOARCH,
	}
	log.Printf("Pulling image for platform %s/%s", platform.OS, platform.Architecture)

	desc, err := remote.Get(ref, remote.WithContext(ctx), remote.WithPlatform(platform))
	if err != nil {
		return fmt.Errorf("failed to fetch image descriptor: %w", err)
	}

	img, err := desc.Image()
	if err != nil {
		return fmt.Errorf("failed to resolve image: %w", err)
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

	// Decompress vmlinuz for Apple VZ (which requires uncompressed ELF)
	if err := d.decompressKernel(filepath.Join(tempDir, "vmlinuz")); err != nil {
		return fmt.Errorf("failed to decompress kernel: %w", err)
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

	// Remove any existing cache directory (e.g., from a previous partial download)
	if err := os.RemoveAll(cacheDir); err != nil {
		return fmt.Errorf("failed to remove existing cache directory: %w", err)
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

// compressionFormat describes a known kernel compression format.
type compressionFormat struct {
	name       string
	magic      []byte
	decompress func([]byte) ([]byte, error)
}

// knownFormats lists compression formats to scan for inside vmlinuz.
var knownFormats = []compressionFormat{
	{"gzip", []byte{0x1f, 0x8b, 0x08}, func(data []byte) ([]byte, error) {
		r, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		defer r.Close()
		return io.ReadAll(r)
	}},
	{"zstd", []byte{0x28, 0xb5, 0x2f, 0xfd}, func(data []byte) ([]byte, error) {
		// The kernel's zstd compressor uses 128MB windows.
		dec, err := zstd.NewReader(nil, zstd.WithDecoderMaxWindow(1<<31), zstd.WithDecoderConcurrency(1))
		if err != nil {
			return nil, err
		}
		defer dec.Close()
		// DecodeAll decodes all concatenated frames. When the compressed kernel
		// is embedded in a vmlinuz payload, trailing bytes after the frame cause
		// a "magic number mismatch" error on the non-existent second frame.
		// The first frame's data is still returned, so use it if valid.
		out, decErr := dec.DecodeAll(data, nil)
		if len(out) > 0 {
			return out, nil
		}
		return nil, decErr
	}},
	{"xz", []byte{0xfd, '7', 'z', 'X', 'Z', 0x00}, func(data []byte) ([]byte, error) {
		r, err := xz.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		return io.ReadAll(r)
	}},
	{"lzma", []byte{0x5d, 0x00, 0x00}, func(data []byte) ([]byte, error) {
		r, err := lzma.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		return io.ReadAll(r)
	}},
}

// isKernelImage checks if data is a valid uncompressed Linux kernel.
// Supports x86_64 ELF and ARM64 Image formats.
func isKernelImage(data []byte) bool {
	// x86_64 ELF: starts with 0x7f ELF
	if len(data) >= 4 && bytes.Equal(data[:4], []byte{0x7f, 'E', 'L', 'F'}) {
		return true
	}
	// ARM64 Image: has "ARMd" magic at offset 0x38
	if len(data) > 0x3c && bytes.Equal(data[0x38:0x3c], []byte("ARMd")) {
		return true
	}
	return false
}

// decompressKernel extracts an uncompressed kernel from a vmlinuz file.
// Apple Virtualization framework requires an uncompressed kernel image
// (ELF for x86_64 or Image for ARM64).
//
// vmlinuz files may be:
// 1. Already uncompressed (ELF or ARM64 Image)
// 2. Directly compressed (gzip/zstd/xz/lzma at offset 0)
// 3. An x86 PE/EFI boot stub with compressed payload embedded at an offset
//
// For case 3, we use the Linux boot protocol header to locate the payload,
// then fall back to scanning for compression magic bytes throughout the file
// (like the kernel's scripts/extract-vmlinux).
func (d *ImageDownloader) decompressKernel(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	// Case 1: already uncompressed kernel
	if isKernelImage(data) {
		log.Printf("Kernel is already uncompressed")
		return nil
	}

	// Case 2: directly compressed (e.g., ARM64 gzip vmlinuz)
	for _, cf := range knownFormats {
		if len(data) < len(cf.magic) || !bytes.Equal(data[:len(cf.magic)], cf.magic) {
			continue
		}
		log.Printf("vmlinuz is directly %s compressed, decompressing", cf.name)
		decompressed, err := cf.decompress(data)
		if err != nil {
			log.Printf("Direct %s decompression failed: %v", cf.name, err)
			break // fall through to other methods
		}
		if isKernelImage(decompressed) {
			log.Printf("Successfully decompressed %s kernel (%d bytes)", cf.name, len(decompressed))
			return os.WriteFile(path, decompressed, 0644)
		}
		log.Printf("Direct %s decompression produced non-kernel data, continuing", cf.name)
		break
	}

	// Case 3: x86 PE/EFI stub — use the Linux boot protocol header to find the payload.
	if len(data) > 0x250 && bytes.Equal(data[0x202:0x206], []byte("HdrS")) {
		setupSects := int(data[0x1f1])
		if setupSects == 0 {
			setupSects = 4 // default per boot protocol
		}
		protectedModeStart := (setupSects + 1) * 512
		payloadOffset := int(binary.LittleEndian.Uint32(data[0x248:0x24c]))
		payloadLength := int(binary.LittleEndian.Uint32(data[0x24c:0x250]))

		absOffset := protectedModeStart + payloadOffset
		absEnd := absOffset + payloadLength

		log.Printf("Linux boot protocol: setup_sects=%d, protected_mode_start=%d, payload_offset=%d, payload_length=%d, abs_offset=%d",
			setupSects, protectedModeStart, payloadOffset, payloadLength, absOffset)

		if absOffset > 0 && absEnd <= len(data) && payloadLength > 0 {
			payload := data[absOffset:absEnd]
			result, err := d.tryDecompress(payload)
			if err == nil {
				log.Printf("Successfully extracted kernel (%d bytes) via boot protocol header", len(result))
				return os.WriteFile(path, result, 0644)
			}
			log.Printf("Boot protocol payload decompression failed: %v, falling back to magic scan", err)
		} else {
			log.Printf("Boot protocol header has invalid offsets, falling back to magic scan")
		}
	}

	// Fallback: scan for compression magic bytes throughout the file
	// (like the kernel's scripts/extract-vmlinux).
	for _, cf := range knownFormats {
		searchFrom := 0
		for {
			idx := bytes.Index(data[searchFrom:], cf.magic)
			if idx < 0 {
				break
			}
			offset := searchFrom + idx
			searchFrom = offset + 1

			log.Printf("Found %s signature at offset %d, attempting decompression", cf.name, offset)

			decompressed, err := cf.decompress(data[offset:])
			if err != nil {
				log.Printf("Failed to decompress %s at offset %d: %v", cf.name, offset, err)
				continue
			}

			if !isKernelImage(decompressed) {
				log.Printf("Decompressed %s at offset %d did not produce valid kernel, skipping", cf.name, offset)
				continue
			}

			log.Printf("Successfully extracted kernel (%d bytes) from %s at offset %d", len(decompressed), cf.name, offset)
			return os.WriteFile(path, decompressed, 0644)
		}
	}

	return fmt.Errorf("could not extract kernel from vmlinuz (file starts with %x)", data[:min(4, len(data))])
}

// tryDecompress attempts to decompress data using each known format.
func (d *ImageDownloader) tryDecompress(data []byte) ([]byte, error) {
	for _, cf := range knownFormats {
		if len(data) < len(cf.magic) || !bytes.Equal(data[:len(cf.magic)], cf.magic) {
			continue
		}

		log.Printf("Payload matches %s format", cf.name)
		decompressed, err := cf.decompress(data)
		if err != nil {
			return nil, fmt.Errorf("%s decompress: %w", cf.name, err)
		}

		if isKernelImage(decompressed) {
			return decompressed, nil
		}
		return nil, fmt.Errorf("%s decompressed data is not a valid kernel (starts with %x)", cf.name, decompressed[:min(4, len(decompressed))])
	}

	// No magic match — try all formats anyway (payload may have a small header before compression)
	for _, cf := range knownFormats {
		idx := bytes.Index(data, cf.magic)
		if idx < 0 || idx > 1024 {
			continue
		}
		log.Printf("Found %s signature at payload offset %d", cf.name, idx)
		decompressed, err := cf.decompress(data[idx:])
		if err != nil {
			continue
		}
		if isKernelImage(decompressed) {
			return decompressed, nil
		}
	}

	return nil, fmt.Errorf("no known compression format matched payload (starts with %x)", data[:min(4, len(data))])
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
