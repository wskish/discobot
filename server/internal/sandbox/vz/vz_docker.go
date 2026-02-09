//go:build darwin

package vz

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	containerTypes "github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"

	"github.com/obot-platform/discobot/server/internal/config"
	"github.com/obot-platform/discobot/server/internal/sandbox"
	"github.com/obot-platform/discobot/server/internal/sandbox/docker"
	"github.com/obot-platform/discobot/server/internal/sandbox/vm"
)

// SessionProjectResolver looks up the project ID for a session from the database.
// Returns the project ID or an error if the session doesn't exist.
type SessionProjectResolver func(ctx context.Context, sessionID string) (projectID string, err error)

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
	vmManager  vm.ProjectVMManager
	downloadMu sync.RWMutex

	// imageDownloader handles async download of VZ images from registry
	imageDownloader *ImageDownloader

	// dockerProviders maps projectID -> Docker provider (with VSOCK transport)
	dockerProviders   map[string]*docker.Provider
	dockerProvidersMu sync.RWMutex

	// sessionProjectResolver looks up session -> project mapping from the database.
	sessionProjectResolver SessionProjectResolver

	// hostDockerClient connects to the host's Docker daemon (for image transfer to VMs)
	hostDockerClient     *dockerclient.Client
	hostDockerClientOnce sync.Once
	hostDockerClientErr  error
}

// NewProvider creates a new VZ+Docker hybrid provider.
// This is the main entry point that matches the Provider interface.
// The resolver function looks up the project ID for a session from the database.
func NewProvider(cfg *config.Config, vmConfig *vm.Config, resolver SessionProjectResolver) (*DockerProvider, error) {
	return NewDockerProvider(cfg, *vmConfig, resolver)
}

// NewDockerProvider creates a new VZ+Docker hybrid provider.
// If kernel and base disk paths are not configured, it starts an async download
// from the container registry specified in vmConfig.ImageRef.
// The resolver function looks up the project ID for a session from the database.
func NewDockerProvider(cfg *config.Config, vmConfig vm.Config, resolver SessionProjectResolver) (*DockerProvider, error) {
	p := &DockerProvider{
		cfg:                    cfg,
		dockerProviders:        make(map[string]*docker.Provider),
		sessionProjectResolver: resolver,
	}

	// Check if we need to download images
	needsDownload := vmConfig.KernelPath == "" || vmConfig.BaseDiskPath == ""

	if needsDownload {
		// Auto-download from registry
		imageRef := vmConfig.ImageRef
		if imageRef == "" {
			imageRef = config.DefaultVZImage()
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
			vmManager, err := NewVMManager(vmConfig)
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
	vmManager, err := NewVMManager(vmConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create VZ VM manager: %w", err)
	}

	p.vmManager = vmManager
	log.Printf("VZ VM manager initialized with manual configuration")
	return p, nil
}

// ImageExists checks if the Docker image exists.
// Note: This checks the local Docker daemon, not the VM's Docker daemon.
func (p *DockerProvider) ImageExists(_ context.Context) bool {
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
	// Resolve project ID from the session in the database
	projectID, err := p.sessionProjectResolver(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve project for session %s: %w", sessionID, err)
	}

	// Check if vmManager is ready
	p.downloadMu.RLock()
	vmManager := p.vmManager
	p.downloadMu.RUnlock()

	if vmManager == nil {
		return nil, fmt.Errorf("VZ provider not ready, images still downloading")
	}

	log.Printf("Creating sandbox for session %s in project %s", sessionID, projectID)

	// Get or create project VM
	pvm, err := vmManager.GetOrCreateVM(ctx, projectID, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get/create project VM: %w", err)
	}

	// Get or create Docker provider for this project
	dockerProv, err := p.getOrCreateDockerProvider(ctx, projectID, pvm)
	if err != nil {
		return nil, fmt.Errorf("failed to get/create Docker provider: %w", err)
	}

	// Create container inside the VM
	sb, err := dockerProv.Create(ctx, sessionID, opts)
	if err != nil {
		return nil, err
	}

	log.Printf("Created container for session %s in project VM %s", sessionID, projectID)
	return sb, nil
}

// Start starts a sandbox (container inside the project VM).
func (p *DockerProvider) Start(ctx context.Context, sessionID string) error {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return err
	}
	return dockerProv.Start(ctx, sessionID)
}

// Stop stops a sandbox (container inside the project VM).
func (p *DockerProvider) Stop(ctx context.Context, sessionID string, timeout time.Duration) error {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return err
	}
	return dockerProv.Stop(ctx, sessionID, timeout)
}

// Remove removes a sandbox (container inside the project VM).
// Also removes the session from the project VM reference count.
func (p *DockerProvider) Remove(ctx context.Context, sessionID string, opts ...sandbox.RemoveOption) error {
	projectID, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return err
	}

	// Remove container
	if err := dockerProv.Remove(ctx, sessionID, opts...); err != nil {
		return err
	}

	// Remove session from project VM
	if err := p.vmManager.RemoveSession(projectID, sessionID); err != nil {
		log.Printf("Warning: failed to remove session from project VM: %v", err)
	}

	return nil
}

// Get returns sandbox information.
func (p *DockerProvider) Get(ctx context.Context, sessionID string) (*sandbox.Sandbox, error) {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.Get(ctx, sessionID)
}

// GetSecret returns the sandbox secret.
func (p *DockerProvider) GetSecret(ctx context.Context, sessionID string) (string, error) {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
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
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.Exec(ctx, sessionID, cmd, opts)
}

// Attach creates an interactive PTY session.
func (p *DockerProvider) Attach(ctx context.Context, sessionID string, opts sandbox.AttachOptions) (sandbox.PTY, error) {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.Attach(ctx, sessionID, opts)
}

// ExecStream executes a streaming command.
func (p *DockerProvider) ExecStream(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecStreamOptions) (sandbox.Stream, error) {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.ExecStream(ctx, sessionID, cmd, opts)
}

// HTTPClient returns an HTTP client for communicating with the sandbox.
// Overrides the Docker provider's localhost-based transport with VSOCK port forwarding,
// since the VM's localhost is not reachable from the macOS host.
func (p *DockerProvider) HTTPClient(ctx context.Context, sessionID string) (*http.Client, error) {
	projectID, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Get the container's mapped port
	sb, err := dockerProv.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Find port 3002's host mapping
	var hostPort int
	for _, port := range sb.Ports {
		if port.ContainerPort == 3002 {
			hostPort = port.HostPort
			break
		}
	}
	if hostPort == 0 {
		return nil, fmt.Errorf("sandbox does not expose port 3002")
	}

	// Get VM and create VSOCK-based transport
	pvm, ok := p.vmManager.GetVM(projectID)
	if !ok {
		return nil, fmt.Errorf("no running VM for project %s", projectID)
	}

	dialer := pvm.PortDialer(uint32(hostPort))

	return &http.Client{
		Transport: &http.Transport{
			DialContext: dialer,
		},
	}, nil
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

	// Close host Docker client if initialized
	if p.hostDockerClient != nil {
		_ = p.hostDockerClient.Close()
	}

	return nil
}

// Status returns the current status of the VZ provider.
// Implements sandbox.StatusProvider.
func (p *DockerProvider) Status() sandbox.ProviderStatus {
	p.downloadMu.RLock()
	vmManager := p.vmManager
	downloader := p.imageDownloader
	p.downloadMu.RUnlock()

	status := sandbox.ProviderStatus{
		Available: true,
	}
	details := StatusDetails{}

	// If downloader exists, we're in async download mode
	if downloader != nil {
		progress := downloader.Status()
		details.Progress = &progress

		switch progress.State {
		case DownloadStateDownloading, DownloadStateExtracting:
			status.State = "downloading"
			status.Message = "Downloading VZ kernel and base disk images"
		case DownloadStateReady:
			status.State = "ready"
			if kernelPath, baseDiskPath, ok := downloader.GetPaths(); ok {
				memoryMB := defaultMemoryBytes / (1024 * 1024)
				if p.cfg.VZMemoryMB > 0 {
					memoryMB = p.cfg.VZMemoryMB
				}
				cpuCount := runtime.NumCPU()
				if p.cfg.VZCPUCount > 0 {
					cpuCount = p.cfg.VZCPUCount
				}
				dataDiskGB := defaultDataDiskGB
				if p.cfg.VZDataDiskGB > 0 {
					dataDiskGB = p.cfg.VZDataDiskGB
				}
				details.Config = &ProviderConfigInfo{
					KernelPath:   kernelPath,
					BaseDiskPath: baseDiskPath,
					MemoryMB:     memoryMB,
					CPUCount:     cpuCount,
					DataDiskGB:   dataDiskGB,
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
	} else {
		// Shouldn't happen, but handle gracefully
		status.State = "failed"
		status.Message = "Provider not properly initialized"
	}

	if details.Progress != nil || details.Config != nil {
		status.Details = details
	}

	return status
}

// GetVMForProject returns the project VM if it exists.
// This is used by the debug Docker proxy to get the VSOCK dialer.
func (p *DockerProvider) GetVMForProject(projectID string) (vm.ProjectVM, bool) {
	p.downloadMu.RLock()
	vmManager := p.vmManager
	p.downloadMu.RUnlock()

	if vmManager == nil {
		return nil, false
	}

	return vmManager.GetVM(projectID)
}

// DockerTransport returns an http.RoundTripper that communicates with the Docker
// daemon inside the VM for the given project. Implements sandbox.DockerProxyProvider.
func (p *DockerProvider) DockerTransport(projectID string) (http.RoundTripper, error) {
	projectVM, ok := p.GetVMForProject(projectID)
	if !ok {
		return nil, fmt.Errorf("no VM found for project %q", projectID)
	}

	return &http.Transport{
		DialContext: projectVM.DockerDialer(),
	}, nil
}

// IsReady returns true if the provider is ready to create VMs.
func (p *DockerProvider) IsReady() bool {
	p.downloadMu.RLock()
	defer p.downloadMu.RUnlock()
	return p.vmManager != nil
}

// WarmVM pre-creates a VM for the given project without starting any containers.
// Returns an error if the provider is not ready (images still downloading).
func (p *DockerProvider) WarmVM(ctx context.Context, projectID string) error {
	p.downloadMu.RLock()
	vmManager := p.vmManager
	p.downloadMu.RUnlock()

	if vmManager == nil {
		return fmt.Errorf("VZ provider not ready, images still downloading")
	}

	_, err := vmManager.WarmVM(ctx, projectID)
	return err
}

// WaitForReady blocks until the VZ provider is ready (images downloaded and VM manager initialized).
// Returns an error if the download fails or the context is cancelled.
func (p *DockerProvider) WaitForReady(ctx context.Context) error {
	if p.IsReady() {
		return nil
	}

	p.downloadMu.RLock()
	downloader := p.imageDownloader
	p.downloadMu.RUnlock()

	if downloader == nil {
		return fmt.Errorf("VZ provider not properly initialized")
	}

	if err := downloader.Wait(ctx); err != nil {
		return fmt.Errorf("VZ image download failed: %w", err)
	}

	// Poll briefly for vmManager to be set after download completes
	for i := 0; i < 50; i++ {
		if p.IsReady() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}

	return fmt.Errorf("VZ provider not ready after download completed")
}

// getHostDockerClient returns a Docker client connected to the host's Docker daemon.
// Used to export locally-built images for transfer into VMs.
func (p *DockerProvider) getHostDockerClient() (*dockerclient.Client, error) {
	p.hostDockerClientOnce.Do(func() {
		clientOpts := []dockerclient.Opt{
			dockerclient.FromEnv,
			dockerclient.WithAPIVersionNegotiation(),
		}
		if p.cfg.DockerHost != "" {
			clientOpts = append(clientOpts, dockerclient.WithHost(p.cfg.DockerHost))
		} else if host := docker.DetectDockerHost(); host != "" {
			clientOpts = append(clientOpts, dockerclient.WithHost(host))
		}

		cli, err := dockerclient.NewClientWithOpts(clientOpts...)
		if err != nil {
			p.hostDockerClientErr = fmt.Errorf("failed to create host docker client: %w", err)
			return
		}
		p.hostDockerClient = cli
	})
	return p.hostDockerClient, p.hostDockerClientErr
}

// ensureImageInVM loads the sandbox image from the host's Docker into the VM's Docker
// when the image is a locally-built sha256 digest that cannot be pulled from a registry.
func (p *DockerProvider) ensureImageInVM(ctx context.Context, dockerProv *docker.Provider) error {
	image := p.cfg.SandboxImage

	// Only handle local digest images — registry images are pulled by ensureImage()
	if !strings.HasPrefix(image, "sha256:") {
		return nil
	}

	// Check if image already exists in VM's Docker
	vmClient := dockerProv.Client()
	inspect, err := vmClient.ImageInspect(ctx, image)
	if err == nil {
		log.Printf("Image %s already exists in VM Docker (ID: %s)", image[:19], inspect.ID[:19])
		return nil
	}
	log.Printf("Image %s not found in VM Docker, will load from host: %v", image[:19], err)

	// Get host Docker client
	hostClient, err := p.getHostDockerClient()
	if err != nil {
		return fmt.Errorf("failed to get host docker client: %w", err)
	}

	// Verify image exists on host
	if _, err := hostClient.ImageInspect(ctx, image); err != nil {
		return fmt.Errorf("image %s not found on host docker: %w", image[:19], err)
	}

	// Get image size for progress reporting
	inspectResult, err := hostClient.ImageInspect(ctx, image)
	if err != nil {
		return fmt.Errorf("failed to inspect image on host: %w", err)
	}
	imageSize := inspectResult.Size
	log.Printf("Loading image %s (%d MB) from host Docker into VM Docker...", image[:19], imageSize/(1024*1024))

	// Stream image from host to VM: ImageSave → progressReader → ImageLoad
	reader, err := hostClient.ImageSave(ctx, []string{image})
	if err != nil {
		return fmt.Errorf("failed to export image from host: %w", err)
	}
	defer reader.Close()

	pr := &progressReader{
		reader:   reader,
		total:    imageSize,
		logEvery: 100 * 1024 * 1024, // Log every 100MB
		label:    image[:19],
	}

	resp, err := vmClient.ImageLoad(ctx, pr, dockerclient.ImageLoadWithQuiet(true))
	if err != nil {
		return fmt.Errorf("failed to load image into VM: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	log.Printf("Successfully loaded image %s into VM Docker", image[:19])
	return nil
}

// getOrCreateDockerProvider gets or creates a Docker provider for the given project.
// The Docker provider connects to the Docker daemon inside the project VM via VSOCK.
func (p *DockerProvider) getOrCreateDockerProvider(ctx context.Context, projectID string, pvm vm.ProjectVM) (*docker.Provider, error) {
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

	// Create Docker provider with VSOCK transport and session resolver for cache volumes
	dockerProv, err := docker.NewProvider(
		p.cfg,
		docker.SessionProjectResolver(p.sessionProjectResolver),
		docker.WithVsockDialer(pvm.DockerDialer()),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create Docker provider: %w", err)
	}

	// Load sandbox image into VM if it's a local digest
	if err := p.ensureImageInVM(ctx, dockerProv); err != nil {
		return nil, fmt.Errorf("failed to load sandbox image into VM: %w", err)
	}

	// Start proxy container for VSOCK port forwarding
	if err := p.startProxyContainer(ctx, projectID, dockerProv); err != nil {
		return nil, fmt.Errorf("failed to start proxy container for project %s: %w", projectID, err)
	}

	p.dockerProviders[projectID] = dockerProv
	log.Printf("Docker provider created for project %s", projectID)
	return dockerProv, nil
}

// startProxyContainer creates and starts the VSOCK port proxy container inside the VM.
// The proxy watches Docker events for containers with published ports and creates
// socat VSOCK listeners to forward those ports to the host.
func (p *DockerProvider) startProxyContainer(ctx context.Context, projectID string, dockerProv *docker.Provider) error {
	cli := dockerProv.Client()
	suffix := projectID
	if len(suffix) > 8 {
		suffix = suffix[:8]
	}
	name := fmt.Sprintf("discobot-proxy-%s", suffix)

	// Check if proxy container already exists
	existing, err := cli.ContainerInspect(ctx, name)
	if err == nil {
		// Recreate if image changed or not privileged
		needsRecreate := existing.Config.Image != p.cfg.SandboxImage ||
			!existing.HostConfig.Privileged

		if existing.State.Running && !needsRecreate {
			log.Printf("Proxy container %s already running for project %s", name, projectID)
			return nil
		}
		if needsRecreate {
			log.Printf("Proxy container %s has stale config, recreating", name)
		}
		_ = cli.ContainerRemove(ctx, existing.ID, containerTypes.RemoveOptions{Force: true})
	}

	containerConfig := &containerTypes.Config{
		Image: p.cfg.SandboxImage,
		Cmd:   []string{"/opt/discobot/bin/discobot-agent", "proxy"},
		Labels: map[string]string{
			"discobot.proxy":      "true",
			"discobot.project.id": projectID,
		},
	}

	hostConfig := &containerTypes.HostConfig{
		NetworkMode: "host",
		IpcMode:     "host",
		Privileged:  true, // Required for /dev/vsock access
		Binds:       []string{"/var/run/docker.sock:/var/run/docker.sock"},
		RestartPolicy: containerTypes.RestartPolicy{
			Name: containerTypes.RestartPolicyAlways,
		},
	}

	resp, err := cli.ContainerCreate(ctx, containerConfig, hostConfig, nil, nil, name)
	if err != nil {
		return fmt.Errorf("failed to create proxy container: %w", err)
	}

	if err := cli.ContainerStart(ctx, resp.ID, containerTypes.StartOptions{}); err != nil {
		return fmt.Errorf("failed to start proxy container: %w", err)
	}

	log.Printf("Started proxy container %s (%s) for project %s", name, resp.ID[:12], projectID)
	return nil
}

// getDockerProviderForSession resolves the session's project ID from the database
// and returns the corresponding Docker provider. Returns sandbox.ErrNotFound if
// the session doesn't exist or has no running VM.
func (p *DockerProvider) getDockerProviderForSession(ctx context.Context, sessionID string) (string, *docker.Provider, error) {
	projectID, err := p.sessionProjectResolver(ctx, sessionID)
	if err != nil {
		return "", nil, fmt.Errorf("%w: failed to resolve project for session %s: %v", sandbox.ErrNotFound, sessionID, err)
	}

	p.dockerProvidersMu.RLock()
	dockerProv, exists := p.dockerProviders[projectID]
	p.dockerProvidersMu.RUnlock()

	if !exists {
		return "", nil, fmt.Errorf("%w: no running VM for project %s (session %s)", sandbox.ErrNotFound, projectID, sessionID)
	}

	return projectID, dockerProv, nil
}

// progressReader wraps an io.Reader and logs transfer progress.
type progressReader struct {
	reader     io.Reader
	total      int64 // Total expected bytes (0 if unknown)
	read       int64 // Bytes read so far
	lastLogged int64 // Bytes read at last log
	logEvery   int64 // Log every N bytes
	label      string
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.reader.Read(p)
	pr.read += int64(n)

	if pr.read-pr.lastLogged >= pr.logEvery {
		pr.lastLogged = pr.read
		readMB := pr.read / (1024 * 1024)
		if pr.total > 0 {
			totalMB := pr.total / (1024 * 1024)
			pct := pr.read * 100 / pr.total
			log.Printf("Image load %s: %d/%d MB (%d%%)", pr.label, readMB, totalMB, pct)
		} else {
			log.Printf("Image load %s: %d MB transferred", pr.label, readMB)
		}
	}

	return n, err
}
