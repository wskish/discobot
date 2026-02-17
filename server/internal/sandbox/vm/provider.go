package vm

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	dockerclient "github.com/docker/docker/client"

	"github.com/obot-platform/discobot/server/internal/config"
	"github.com/obot-platform/discobot/server/internal/sandbox"
	"github.com/obot-platform/discobot/server/internal/sandbox/docker"
)

// SessionProjectResolver looks up the project ID for a session from the database.
// Returns the project ID or an error if the session doesn't exist.
type SessionProjectResolver func(ctx context.Context, sessionID string) (projectID string, err error)

// SystemManager interface for tracking startup tasks.
type SystemManager interface {
	RegisterTask(id, name string)
	StartTask(id string)
	UpdateTaskProgress(id string, progress int, currentOperation string)
	UpdateTaskBytes(id string, bytesDownloaded, totalBytes int64)
	CompleteTask(id string)
	FailTask(id string, err error)
}

// Provider is a generic VM+Docker hybrid provider that:
//   - Uses a ProjectVMManager to create project-level VMs (one VM per project)
//   - Uses Docker provider to create containers inside those VMs (one container per session)
//   - Communicates with Docker daemon inside VM via the dialer provided by ProjectVM
//
// This provides the isolation benefits of VMs at the project level while allowing
// multiple sessions to share a VM, with session-level isolation via containers.
type Provider struct {
	cfg *config.Config

	// vmManager manages project-level VMs (abstraction).
	vmManager ProjectVMManager

	// dockerProviders maps projectID -> Docker provider (with VM transport).
	dockerProviders   map[string]*docker.Provider
	dockerProvidersMu sync.RWMutex

	// sessionProjectResolver looks up session -> project mapping from the database.
	sessionProjectResolver SessionProjectResolver

	// hostDockerClient connects to the host's Docker daemon (for image transfer to VMs).
	hostDockerClient     *dockerclient.Client
	hostDockerClientOnce sync.Once
	hostDockerClientErr  error

	// systemManager tracks startup tasks and system status (optional).
	systemManager SystemManager

	// postVMSetup is called after a VM's Docker provider is created and images are loaded.
	// Used by VZ to start the proxy container.
	postVMSetup func(ctx context.Context, projectID string, dockerProv *docker.Provider) error

	// idleTimeout is how long a VM with no running sandboxes can be idle before shutdown.
	// Zero means VMs are never shut down automatically.
	idleTimeout time.Duration

	// idleSince tracks when each project's VM first had no running sandboxes.
	// Reset when sandboxes are running again.
	idleSince   map[string]time.Time
	idleSinceMu sync.Mutex

	// stopCh signals background goroutines to stop.
	stopCh chan struct{}
}

// Option configures a Provider.
type Option func(*Provider)

// WithPostVMSetup sets a callback called after a VM's Docker provider is created
// and images are loaded. VZ uses this to start the VSOCK proxy container.
func WithPostVMSetup(fn func(ctx context.Context, projectID string, dockerProv *docker.Provider) error) Option {
	return func(p *Provider) {
		p.postVMSetup = fn
	}
}

// WithIdleTimeout sets how long a VM with no running sandboxes can be idle
// before being automatically shut down. Zero (default) means never shut down.
func WithIdleTimeout(d time.Duration) Option {
	return func(p *Provider) {
		p.idleTimeout = d
	}
}

// NewProvider creates a new VM+Docker hybrid provider.
// The vmManager provides VMs with Docker daemons; the provider creates Docker
// containers inside those VMs for session isolation.
func NewProvider(cfg *config.Config, vmManager ProjectVMManager, resolver SessionProjectResolver, systemManager SystemManager, opts ...Option) *Provider {
	p := &Provider{
		cfg:                    cfg,
		vmManager:              vmManager,
		dockerProviders:        make(map[string]*docker.Provider),
		sessionProjectResolver: resolver,
		systemManager:          systemManager,
		idleSince:              make(map[string]time.Time),
		stopCh:                 make(chan struct{}),
	}

	for _, opt := range opts {
		opt(p)
	}

	// Pre-warm the "local" project VM and start idle cleanup after the manager is ready
	go func() {
		<-vmManager.Ready()
		if vmManager.Err() != nil {
			return
		}
		if _, err := p.getOrCreateDockerProvider(context.Background(), "local"); err != nil {
			log.Printf("failed to warm VM for local project: %v", err)
		}

		// Start idle VM cleanup after ready
		if p.idleTimeout > 0 {
			go p.cleanupIdleVMs()
		}
	}()

	return p
}

// ImageExists checks if the Docker image exists.
// Checks VM Docker daemons first (if any VMs are running), then falls back to host Docker.
func (p *Provider) ImageExists(ctx context.Context) bool {
	image := p.cfg.SandboxImage

	// First, check if image exists in any running VM's Docker daemon
	p.dockerProvidersMu.RLock()
	for _, dp := range p.dockerProviders {
		if dp.ImageExists(ctx) {
			p.dockerProvidersMu.RUnlock()
			return true
		}
	}
	p.dockerProvidersMu.RUnlock()

	// Fall back to host Docker daemon for verification
	client, err := p.getHostDockerClient()
	if err != nil {
		return false
	}

	_, err = client.ImageInspect(ctx, image)
	return err == nil
}

// Image returns the sandbox image name.
func (p *Provider) Image() string {
	return p.cfg.SandboxImage
}

// Create creates a sandbox in the project's VM.
func (p *Provider) Create(ctx context.Context, sessionID string, opts sandbox.CreateOptions) (*sandbox.Sandbox, error) {
	projectID, err := p.sessionProjectResolver(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve project for session %s: %w", sessionID, err)
	}

	dockerProv, err := p.getOrCreateDockerProvider(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to get docker provider: %w", err)
	}

	return dockerProv.Create(ctx, sessionID, opts)
}

// Start starts a sandbox.
func (p *Provider) Start(ctx context.Context, sessionID string) error {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return err
	}
	return dockerProv.Start(ctx, sessionID)
}

// Stop stops a sandbox.
func (p *Provider) Stop(ctx context.Context, sessionID string, timeout time.Duration) error {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return err
	}
	return dockerProv.Stop(ctx, sessionID, timeout)
}

// Remove removes a sandbox.
func (p *Provider) Remove(ctx context.Context, sessionID string, opts ...sandbox.RemoveOption) error {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return err
	}
	return dockerProv.Remove(ctx, sessionID, opts...)
}

// Get returns sandbox info.
func (p *Provider) Get(ctx context.Context, sessionID string) (*sandbox.Sandbox, error) {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.Get(ctx, sessionID)
}

// GetSecret returns the shared secret for a sandbox.
func (p *Provider) GetSecret(ctx context.Context, sessionID string) (string, error) {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return "", err
	}
	return dockerProv.GetSecret(ctx, sessionID)
}

// List returns all sandboxes across all project VMs.
func (p *Provider) List(ctx context.Context) ([]*sandbox.Sandbox, error) {
	p.dockerProvidersMu.RLock()
	providers := make([]*docker.Provider, 0, len(p.dockerProviders))
	for _, prov := range p.dockerProviders {
		providers = append(providers, prov)
	}
	p.dockerProvidersMu.RUnlock()

	var allSandboxes []*sandbox.Sandbox
	for _, dockerProv := range providers {
		sandboxes, err := dockerProv.List(ctx)
		if err != nil {
			log.Printf("Warning: Failed to list sandboxes from a VM Docker provider: %v", err)
			continue
		}
		allSandboxes = append(allSandboxes, sandboxes...)
	}
	return allSandboxes, nil
}

// Exec executes a command in a sandbox.
func (p *Provider) Exec(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecOptions) (*sandbox.ExecResult, error) {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.Exec(ctx, sessionID, cmd, opts)
}

// Attach attaches to a sandbox.
func (p *Provider) Attach(ctx context.Context, sessionID string, opts sandbox.AttachOptions) (sandbox.PTY, error) {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.Attach(ctx, sessionID, opts)
}

// ExecStream executes a streaming command in a sandbox.
func (p *Provider) ExecStream(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecStreamOptions) (sandbox.Stream, error) {
	_, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return dockerProv.ExecStream(ctx, sessionID, cmd, opts)
}

// HTTPClient returns an HTTP client that connects to the sandbox's published port
// via the VM's port dialer.
func (p *Provider) HTTPClient(ctx context.Context, sessionID string) (*http.Client, error) {
	projectID, dockerProv, err := p.getDockerProviderForSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	pvm, ok := p.GetVMForProject(projectID)
	if !ok {
		return nil, fmt.Errorf("no VM found for project %q", projectID)
	}

	// Get the sandbox to find its published port
	sb, err := dockerProv.Get(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get sandbox info: %w", err)
	}

	// Find the host port for the container port
	var hostPort uint32
	for _, port := range sb.Ports {
		if port.ContainerPort == 3002 {
			hostPort = uint32(port.HostPort)
			break
		}
	}
	if hostPort == 0 {
		return nil, fmt.Errorf("no published port found for sandbox %s", sessionID)
	}

	return &http.Client{
		Transport: &http.Transport{
			DisableKeepAlives: true,
			DialContext:       pvm.PortDialer(hostPort),
		},
	}, nil
}

// Watch merges state events from all Docker providers.
func (p *Provider) Watch(ctx context.Context) (<-chan sandbox.StateEvent, error) {
	p.dockerProvidersMu.RLock()
	providers := make([]*docker.Provider, 0, len(p.dockerProviders))
	for _, prov := range p.dockerProviders {
		providers = append(providers, prov)
	}
	p.dockerProvidersMu.RUnlock()

	merged := make(chan sandbox.StateEvent, 32)

	var wg sync.WaitGroup
	for _, prov := range providers {
		ch, err := prov.Watch(ctx)
		if err != nil {
			continue
		}
		wg.Add(1)
		go func(ch <-chan sandbox.StateEvent) {
			defer wg.Done()
			for event := range ch {
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
func (p *Provider) Close() error {
	log.Printf("Shutting down VM+Docker provider")

	close(p.stopCh)
	p.vmManager.Shutdown()

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

// CleanupImages delegates to all per-project Docker providers to clean up old images.
// Implements sandbox.ImageCleaner.
func (p *Provider) CleanupImages(ctx context.Context) error {
	p.dockerProvidersMu.RLock()
	providers := make([]*docker.Provider, 0, len(p.dockerProviders))
	for _, prov := range p.dockerProviders {
		providers = append(providers, prov)
	}
	p.dockerProvidersMu.RUnlock()

	for _, dockerProv := range providers {
		if err := dockerProv.CleanupImages(ctx); err != nil {
			log.Printf("Warning: Failed to clean up images in VM Docker provider: %v", err)
		}
	}
	return nil
}

// Status returns the current status of the VM provider.
// Implements sandbox.StatusProvider.
func (p *Provider) Status() sandbox.ProviderStatus {
	// Delegate to the VM manager if it implements StatusReporter
	if reporter, ok := p.vmManager.(StatusReporter); ok {
		return reporter.Status()
	}

	// Basic status based on Ready/Err
	select {
	case <-p.vmManager.Ready():
		if err := p.vmManager.Err(); err != nil {
			return sandbox.ProviderStatus{
				Available: false,
				State:     "failed",
				Message:   err.Error(),
			}
		}
		return sandbox.ProviderStatus{
			Available: true,
			State:     "ready",
		}
	default:
		return sandbox.ProviderStatus{
			Available: true,
			State:     "initializing",
			Message:   "VM manager initializing",
		}
	}
}

// GetVMForProject returns the project VM if it exists.
// This is used by the debug Docker proxy to get the VM dialer.
func (p *Provider) GetVMForProject(projectID string) (ProjectVM, bool) {
	select {
	case <-p.vmManager.Ready():
		if p.vmManager.Err() != nil {
			return nil, false
		}
	default:
		return nil, false
	}
	return p.vmManager.GetVM(projectID)
}

// DockerTransport returns an http.RoundTripper that communicates with the Docker
// daemon inside the VM for the given project. Implements sandbox.DockerProxyProvider.
func (p *Provider) DockerTransport(projectID string) (http.RoundTripper, error) {
	projectVM, ok := p.GetVMForProject(projectID)
	if !ok {
		return nil, fmt.Errorf("no VM found for project %q", projectID)
	}

	return &http.Transport{
		DialContext: projectVM.DockerDialer(),
	}, nil
}

// IsReady returns true if the provider is ready to create VMs.
func (p *Provider) IsReady() bool {
	select {
	case <-p.vmManager.Ready():
		return p.vmManager.Err() == nil
	default:
		return false
	}
}

// WaitForReady blocks until the VM provider is ready.
// Returns an error if initialization fails or the context is cancelled.
func (p *Provider) WaitForReady(ctx context.Context) error {
	select {
	case <-p.vmManager.Ready():
		return p.vmManager.Err()
	case <-ctx.Done():
		return ctx.Err()
	}
}

// getHostDockerClient returns a Docker client connected to the host's Docker daemon.
// Used to export locally-built images for transfer into VMs.
func (p *Provider) getHostDockerClient() (*dockerclient.Client, error) {
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
// when the image is local (discobot-local/ tag) and cannot be pulled from a registry.
func (p *Provider) ensureImageInVM(ctx context.Context, dockerProv *docker.Provider) error {
	image := p.cfg.SandboxImage

	// Only handle local images (discobot-local/ prefixed tags).
	// Registry images are pulled by ensureImage().
	if !strings.HasPrefix(image, "discobot-local/") {
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

	// Register system manager task for UI progress
	if p.systemManager != nil {
		p.systemManager.RegisterTask("docker-load", fmt.Sprintf("Loading Docker image into VM: %s", image[:19]))
		p.systemManager.StartTask("docker-load")
	}

	// Stream image from host to VM: ImageSave → progressReader → ImageLoad
	reader, err := hostClient.ImageSave(ctx, []string{image})
	if err != nil {
		if p.systemManager != nil {
			p.systemManager.FailTask("docker-load", err)
		}
		return fmt.Errorf("failed to export image from host: %w", err)
	}
	defer reader.Close()

	pr := &progressReader{
		reader:       reader,
		total:        imageSize,
		logEvery:     100 * 1024 * 1024, // Log every 100MB
		label:        image[:19],
		systemMgr:    p.systemManager,
		systemTaskID: "docker-load",
	}

	resp, err := vmClient.ImageLoad(ctx, pr, dockerclient.ImageLoadWithQuiet(true))
	if err != nil {
		if p.systemManager != nil {
			p.systemManager.FailTask("docker-load", err)
		}
		return fmt.Errorf("failed to load image into VM: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if p.systemManager != nil {
		p.systemManager.CompleteTask("docker-load")
	}

	log.Printf("Successfully loaded image %s into VM Docker", image[:19])
	return nil
}

// getOrCreateDockerProvider gets or creates a Docker provider for the given project.
// It ensures the project VM exists (creating one if needed) and sets up a Docker
// provider connected to the VM's Docker daemon via the VM's dialer.
func (p *Provider) getOrCreateDockerProvider(ctx context.Context, projectID string) (*docker.Provider, error) {
	// Non-blocking check: fail immediately if not ready
	select {
	case <-p.vmManager.Ready():
		if err := p.vmManager.Err(); err != nil {
			return nil, fmt.Errorf("VM provider not ready: %w", err)
		}
	default:
		return nil, fmt.Errorf("VM provider not ready, still initializing")
	}

	// Get or create the project VM
	pvm, err := p.vmManager.GetOrCreateVM(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to get/create project VM: %w", err)
	}

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

	// Create Docker provider with VM transport.
	// The provider kicks off image pull in the background on creation.
	opts := []docker.Option{
		docker.WithVsockDialer(pvm.DockerDialer()),
	}
	if p.systemManager != nil {
		opts = append(opts, docker.WithSystemManager(p.systemManager))
	}
	dockerProv, err := docker.NewProvider(
		p.cfg,
		docker.SessionProjectResolver(p.sessionProjectResolver),
		opts...,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create Docker provider: %w", err)
	}

	// Load sandbox image into VM if it's a local image
	if err := p.ensureImageInVM(ctx, dockerProv); err != nil {
		return nil, fmt.Errorf("failed to load sandbox image into VM: %w", err)
	}

	// Run post-VM setup hook (e.g., VZ starts VSOCK proxy container here)
	if p.postVMSetup != nil {
		if err := p.postVMSetup(ctx, projectID, dockerProv); err != nil {
			return nil, fmt.Errorf("post-VM setup failed for project %s: %w", projectID, err)
		}
	}

	p.dockerProviders[projectID] = dockerProv
	log.Printf("Docker provider created for project %s", projectID)
	return dockerProv, nil
}

// getDockerProviderForSession resolves the session's project ID from the database
// and returns the corresponding Docker provider. Returns sandbox.ErrNotFound if
// the session doesn't exist or has no running VM.
func (p *Provider) getDockerProviderForSession(ctx context.Context, sessionID string) (string, *docker.Provider, error) {
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

// countRunningSandboxes returns the number of running sandboxes for a project.
func (p *Provider) countRunningSandboxes(projectID string) int {
	p.dockerProvidersMu.RLock()
	dockerProv, exists := p.dockerProviders[projectID]
	p.dockerProvidersMu.RUnlock()

	if !exists {
		return 0
	}

	sandboxes, err := dockerProv.List(context.Background())
	if err != nil {
		return 0
	}

	count := 0
	for _, sb := range sandboxes {
		if sb.Status == sandbox.StatusRunning {
			count++
		}
	}
	return count
}

// cleanupIdleVMs periodically checks for VMs with no running sandboxes
// and shuts them down after the idle timeout.
func (p *Provider) cleanupIdleVMs() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-p.stopCh:
			return
		case <-ticker.C:
			p.idleSinceMu.Lock()
			for _, projectID := range p.vmManager.ListProjectIDs() {
				if p.countRunningSandboxes(projectID) > 0 {
					// VM is active — clear idle timer
					delete(p.idleSince, projectID)
					continue
				}

				// No running sandboxes — track idle start time
				idleStart, exists := p.idleSince[projectID]
				if !exists {
					p.idleSince[projectID] = time.Now()
					continue
				}

				// Check if idle timeout exceeded
				if time.Since(idleStart) < p.idleTimeout {
					continue
				}

				log.Printf("Shutting down idle project VM: %s (idle for %v)", projectID, time.Since(idleStart))

				if err := p.vmManager.RemoveVM(projectID); err != nil {
					log.Printf("Error removing idle VM %s: %v", projectID, err)
					continue
				}

				p.dockerProvidersMu.Lock()
				delete(p.dockerProviders, projectID)
				p.dockerProvidersMu.Unlock()

				delete(p.idleSince, projectID)
			}
			p.idleSinceMu.Unlock()
		}
	}
}

// progressReader wraps an io.Reader and logs transfer progress.
type progressReader struct {
	reader       io.Reader
	total        int64
	read         int64
	logEvery     int64
	lastLog      int64
	label        string
	systemMgr    SystemManager
	systemTaskID string
}

func (r *progressReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.read += int64(n)

	if r.read-r.lastLog >= r.logEvery {
		pct := float64(r.read) / float64(r.total) * 100
		log.Printf("Image transfer %s: %.1f%% (%d/%d MB)", r.label, pct, r.read/(1024*1024), r.total/(1024*1024))
		r.lastLog = r.read

		if r.systemMgr != nil {
			r.systemMgr.UpdateTaskBytes(r.systemTaskID, r.read, r.total)
		}
	}

	return n, err
}
