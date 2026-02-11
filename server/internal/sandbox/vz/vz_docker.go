//go:build darwin

package vz

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/obot-platform/discobot/server/internal/config"
	"github.com/obot-platform/discobot/server/internal/sandbox"
	"github.com/obot-platform/discobot/server/internal/sandbox/docker"
	"github.com/obot-platform/discobot/server/internal/sandbox/vm"
)

// DockerProvider is a hybrid provider that:
// - Uses Apple Virtualization framework to create project-level VMs (one VM per project)
// - Uses Docker provider to create containers inside those VMs (one container per session)
// - Communicates with Docker daemon inside VM via VSOCK
//
// This provides the isolation benefits of VMs at the project level while allowing
// multiple sessions to share a VM, with session-level isolation via containers.
type DockerProvider struct {
	cfg *config.Config

	// vmManager manages project-level VMs (abstraction)
	// May be nil during async initialization
	vmManager   vm.ProjectVMManager
	downloadMu  sync.RWMutex

	// imageDownloader handles async download of VZ images from registry
	imageDownloader *ImageDownloader

	// dockerProviders maps projectID -> Docker provider (with VSOCK transport)
	dockerProviders   map[string]*docker.Provider
	dockerProvidersMu sync.RWMutex

	// sessionToProject maps sessionID -> projectID for routing
	sessionToProject   map[string]string
	sessionToProjectMu sync.RWMutex
}

// NewProvider creates a new VZ+Docker hybrid provider.
// This is the main entry point that matches the Provider interface.
func NewProvider(cfg *config.Config, vmConfig *vm.Config) (*DockerProvider, error) {
	return NewDockerProvider(cfg, *vmConfig)
}

// NewDockerProvider creates a new VZ+Docker hybrid provider.
// If kernel and base disk paths are not configured, it starts an async download
// from the container registry specified in vmConfig.ImageRef.
func NewDockerProvider(cfg *config.Config, vmConfig vm.Config) (*DockerProvider, error) {
	p := &DockerProvider{
		cfg:              cfg,
		dockerProviders:  make(map[string]*docker.Provider),
		sessionToProject: make(map[string]string),
	}

	// Check if we need to download images
	needsDownload := vmConfig.KernelPath == "" || vmConfig.BaseDiskPath == ""

	if needsDownload {
		// Auto-download from registry
		imageRef := vmConfig.ImageRef
		if imageRef == "" {
			imageRef = config.DefaultVZImage
		}

		log.Printf("VZ kernel or base disk not configured, will download from %s", imageRef)

		downloader := NewImageDownloader(DownloadConfig{
			ImageRef: imageRef,
			DataDir:  vmConfig.DataDir,
		})
		p.imageDownloader = downloader

		// Start async download in background
		go func() {
			ctx := context.Background()
			if err := downloader.Start(ctx); err != nil {
				log.Printf("VZ image download failed: %v", err)
				return
			}

			// Get paths from downloader
			kernelPath, baseDiskPath, ok := downloader.GetPaths()
			if !ok {
				log.Printf("Failed to get VZ image paths after download")
				return
			}

			// Update vmConfig with downloaded paths
			vmConfig.KernelPath = kernelPath
			vmConfig.BaseDiskPath = baseDiskPath

			// Create VM manager now that images are ready
			vmManager, err := NewVzVMManager(vmConfig)
			if err != nil {
				log.Printf("Failed to create VZ VM manager after download: %v", err)
				return
			}

			p.downloadMu.Lock()
			p.vmManager = vmManager
			p.downloadMu.Unlock()

			log.Printf("VZ VM manager initialized after image download")
		}()

		log.Printf("VZ provider created, images downloading in background")
		return p, nil
	}

	// Manual configuration - initialize immediately
	vmManager, err := NewVzVMManager(vmConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create VZ VM manager: %w", err)
	}

	p.vmManager = vmManager
	log.Printf("VZ VM manager initialized with manual configuration")
	return p, nil
}

// ImageExists checks if the Docker image exists.
// Note: This checks the local Docker daemon, not the VM's Docker daemon.
func (p *DockerProvider) ImageExists(ctx context.Context) bool {
	// TODO: This should check inside a VM once one exists
	// For now, we assume the image will be available or pulled when needed
	return true
}

// Image returns the configured sandbox image name.
func (p *DockerProvider) Image() string {
	return p.cfg.SandboxImage
}

// Create creates a new sandbox:
// 1. Gets or creates the project VM
// 2. Creates a Docker provider connected to that VM's Docker daemon via VSOCK
// 3. Creates a container inside the VM using the Docker provider
func (p *DockerProvider) Create(ctx context.Context, sessionID string, opts sandbox.CreateOptions) (*sandbox.Sandbox, error) {
	if opts.ProjectID == "" {
		return nil, fmt.Errorf("ProjectID is required for VZ+Docker provider")
	}

	// Check if vmManager is ready
	p.downloadMu.RLock()
	vmManager := p.vmManager
	p.downloadMu.RUnlock()

	if vmManager == nil {
		return nil, fmt.Errorf("VZ provider not ready, images still downloading")
	}

	log.Printf("Creating sandbox for session %s in project %s", sessionID, opts.ProjectID)

	// Get or create project VM
	pvm, err := vmManager.GetOrCreateVM(ctx, opts.ProjectID, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get/create project VM: %w", err)
	}

	// Get or create Docker provider for this project
	dockerProv, err := p.getOrCreateDockerProvider(opts.ProjectID, pvm)
	if err != nil {
		return nil, fmt.Errorf("failed to get/create Docker provider: %w", err)
	}

	// Store session to project mapping
	p.sessionToProjectMu.Lock()
	p.sessionToProject[sessionID] = opts.ProjectID
	p.sessionToProjectMu.Unlock()

	// Create container inside the VM
	sb, err := dockerProv.Create(ctx, sessionID, opts)
	if err != nil {
		// Clean up mapping on failure
		p.sessionToProjectMu.Lock()
		delete(p.sessionToProject, sessionID)
		p.sessionToProjectMu.Unlock()
		return nil, err
	}

	log.Printf("Created container for session %s in project VM %s", sessionID, opts.ProjectID)
	return sb, nil
}

// Start starts a sandbox (container inside the project VM).
func (p *DockerProvider) Start(ctx context.Context, sessionID string) error {
	dockerProv, err := p.getDockerProviderForSession(sessionID)
	if err != nil {
		return err
	}
	return dockerProv.Start(ctx, sessionID)
}

// Stop stops a sandbox (container inside the project VM).
func (p *DockerProvider) Stop(ctx context.Context, sessionID string, timeout time.Duration) error {
	dockerProv, err := p.getDockerProviderForSession(sessionID)
	if err != nil {
		return err
	}
	return dockerProv.Stop(ctx, sessionID, timeout)
}

// Remove removes a sandbox (container inside the project VM).
// Also removes the session from the project VM reference count.
func (p *DockerProvider) Remove(ctx context.Context, sessionID string, opts ...sandbox.RemoveOption) error {
	dockerProv, err := p.getDockerProviderForSession(sessionID)
	if err != nil {
		return err
	}

	// Remove container
	if err := dockerProv.Remove(ctx, sessionID, opts...); err != nil {
		return err
	}

	// Remove session from project VM
	p.sessionToProjectMu.Lock()
	projectID, exists := p.sessionToProject[sessionID]
	delete(p.sessionToProject, sessionID)
	p.sessionToProjectMu.Unlock()

	if exists {
		if err := p.vmManager.RemoveSession(projectID, sessionID); err != nil {
			log.Printf("Warning: failed to remove session from project VM: %v", err)
		}
	}

	return nil
}

// Get returns sandbox information.
func (p *DockerProvider) Get(ctx context.Context, sessionID string) (*sandbox.Sandbox, error) {
	dockerProv, err := p.getDockerProviderForSession(sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.Get(ctx, sessionID)
}

// GetSecret returns the sandbox secret.
func (p *DockerProvider) GetSecret(ctx context.Context, sessionID string) (string, error) {
	dockerProv, err := p.getDockerProviderForSession(sessionID)
	if err != nil {
		return "", err
	}
	return dockerProv.GetSecret(ctx, sessionID)
}

// List returns all sandboxes across all project VMs.
func (p *DockerProvider) List(ctx context.Context) ([]*sandbox.Sandbox, error) {
	var allSandboxes []*sandbox.Sandbox

	p.dockerProvidersMu.RLock()
	providers := make([]*docker.Provider, 0, len(p.dockerProviders))
	for _, prov := range p.dockerProviders {
		providers = append(providers, prov)
	}
	p.dockerProvidersMu.RUnlock()

	// List sandboxes from all Docker providers
	for _, dockerProv := range providers {
		sandboxes, err := dockerProv.List(ctx)
		if err != nil {
			log.Printf("Warning: failed to list sandboxes from Docker provider: %v", err)
			continue
		}
		allSandboxes = append(allSandboxes, sandboxes...)
	}

	return allSandboxes, nil
}

// Exec executes a command in the sandbox.
func (p *DockerProvider) Exec(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecOptions) (*sandbox.ExecResult, error) {
	dockerProv, err := p.getDockerProviderForSession(sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.Exec(ctx, sessionID, cmd, opts)
}

// Attach creates an interactive PTY session.
func (p *DockerProvider) Attach(ctx context.Context, sessionID string, opts sandbox.AttachOptions) (sandbox.PTY, error) {
	dockerProv, err := p.getDockerProviderForSession(sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.Attach(ctx, sessionID, opts)
}

// ExecStream executes a streaming command.
func (p *DockerProvider) ExecStream(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecStreamOptions) (sandbox.Stream, error) {
	dockerProv, err := p.getDockerProviderForSession(sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.ExecStream(ctx, sessionID, cmd, opts)
}

// HTTPClient returns an HTTP client for communicating with the sandbox.
func (p *DockerProvider) HTTPClient(ctx context.Context, sessionID string) (*http.Client, error) {
	dockerProv, err := p.getDockerProviderForSession(sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.HTTPClient(ctx, sessionID)
}

// Watch watches for sandbox state changes across all Docker providers.
func (p *DockerProvider) Watch(ctx context.Context) (<-chan sandbox.StateEvent, error) {
	merged := make(chan sandbox.StateEvent, 100)

	// Get all current Docker providers
	p.dockerProvidersMu.RLock()
	providers := make([]*docker.Provider, 0, len(p.dockerProviders))
	for _, prov := range p.dockerProviders {
		providers = append(providers, prov)
	}
	p.dockerProvidersMu.RUnlock()

	// Watch all providers
	var wg sync.WaitGroup
	for _, dockerProv := range providers {
		ch, err := dockerProv.Watch(ctx)
		if err != nil {
			log.Printf("Warning: failed to watch Docker provider: %v", err)
			continue
		}

		wg.Add(1)
		go func(eventCh <-chan sandbox.StateEvent) {
			defer wg.Done()
			for event := range eventCh {
				select {
				case merged <- event:
				case <-ctx.Done():
					return
				}
			}
		}(ch)
	}

	// Close merged channel when all watchers are done
	go func() {
		wg.Wait()
		close(merged)
	}()

	return merged, nil
}

// Close shuts down the provider and all project VMs.
func (p *DockerProvider) Close() error {
	log.Printf("Shutting down VZ+Docker provider")

	// Shutdown VM manager if initialized
	p.downloadMu.RLock()
	vmManager := p.vmManager
	p.downloadMu.RUnlock()

	if vmManager != nil {
		vmManager.Shutdown()
	}

	// Close all Docker providers
	p.dockerProvidersMu.Lock()
	for projectID := range p.dockerProviders {
		delete(p.dockerProviders, projectID)
	}
	p.dockerProvidersMu.Unlock()

	return nil
}

// Status returns the current status of the VZ provider.
func (p *DockerProvider) Status() ProviderStatus {
	p.downloadMu.RLock()
	vmManager := p.vmManager
	downloader := p.imageDownloader
	p.downloadMu.RUnlock()

	status := ProviderStatus{
		Available: true,
	}

	// If downloader exists, we're in async download mode
	if downloader != nil {
		progress := downloader.Status()
		status.Progress = &progress

		switch progress.State {
		case DownloadStateDownloading, DownloadStateExtracting:
			status.State = "downloading"
			status.Message = "Downloading VZ kernel and base disk images"
		case DownloadStateReady:
			status.State = "ready"
			if kernelPath, baseDiskPath, ok := downloader.GetPaths(); ok {
				status.Config = &ProviderConfigInfo{
					KernelPath:   kernelPath,
					BaseDiskPath: baseDiskPath,
					MemoryMB:     2048, // Default values
					CPUCount:     2,
				}
			}
		case DownloadStateFailed:
			status.State = "failed"
			status.Message = progress.Error
		default:
			status.State = "downloading"
			status.Message = "Initializing download"
		}
	} else if vmManager != nil {
		// Manual configuration - ready immediately
		status.State = "ready"
		// Config info would be available from vmManager if needed
	} else {
		// Shouldn't happen, but handle gracefully
		status.State = "failed"
		status.Message = "Provider not properly initialized"
	}

	return status
}

// IsReady returns true if the provider is ready to create VMs.
func (p *DockerProvider) IsReady() bool {
	p.downloadMu.RLock()
	defer p.downloadMu.RUnlock()
	return p.vmManager != nil
}

// getOrCreateDockerProvider gets or creates a Docker provider for the given project.
// The Docker provider connects to the Docker daemon inside the project VM via VSOCK.
func (p *DockerProvider) getOrCreateDockerProvider(projectID string, pvm vm.ProjectVM) (*docker.Provider, error) {
	p.dockerProvidersMu.RLock()
	if prov, exists := p.dockerProviders[projectID]; exists {
		p.dockerProvidersMu.RUnlock()
		return prov, nil
	}
	p.dockerProvidersMu.RUnlock()

	p.dockerProvidersMu.Lock()
	defer p.dockerProvidersMu.Unlock()

	// Double-check after acquiring write lock
	if prov, exists := p.dockerProviders[projectID]; exists {
		return prov, nil
	}

	log.Printf("Creating Docker provider for project VM: %s", projectID)

	// Create Docker provider with VSOCK transport
	dockerProv, err := docker.NewProvider(
		p.cfg,
		docker.WithVsockDialer(pvm.DockerDialer()),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create Docker provider: %w", err)
	}

	p.dockerProviders[projectID] = dockerProv
	log.Printf("Docker provider created for project %s", projectID)
	return dockerProv, nil
}

// getDockerProviderForSession returns the Docker provider for the given session.
func (p *DockerProvider) getDockerProviderForSession(sessionID string) (*docker.Provider, error) {
	p.sessionToProjectMu.RLock()
	projectID, exists := p.sessionToProject[sessionID]
	p.sessionToProjectMu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("session %s not found", sessionID)
	}

	p.dockerProvidersMu.RLock()
	dockerProv, exists := p.dockerProviders[projectID]
	p.dockerProvidersMu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("Docker provider not found for project %s", projectID)
	}

	return dockerProv, nil
}
