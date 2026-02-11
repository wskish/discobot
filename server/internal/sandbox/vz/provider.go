// Package vz provides a macOS Virtualization.framework-based implementation of the sandbox.Provider interface.
// It uses Code-Hex/vz to manage lightweight Linux VMs as sandboxes.
//
// Build constraint: This package only builds on darwin (macOS).
//go:build darwin

package vz

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Code-Hex/vz/v3"

	"github.com/obot-platform/octobot/server/internal/config"
	"github.com/obot-platform/octobot/server/internal/sandbox"
)

// eventSubscriber represents a subscriber to sandbox events.
type eventSubscriber struct {
	ch   chan sandbox.StateEvent
	done chan struct{}
}

const (
	// labelSecret is the metadata key for storing the raw shared secret.
	labelSecret = "octobot.secret"

	// containerPort is the fixed port exposed by all sandboxes.
	containerPort = 3002

	// workspacePath is where workspaces are mounted inside the VM.
	workspacePath = "/.workspace"

	// defaultCPUCount is the default number of CPUs for VMs.
	defaultCPUCount = 2

	// defaultMemoryBytes is the default memory for VMs (2GB).
	defaultMemoryBytes = 2 * 1024 * 1024 * 1024

	// vsockPort is the port used for vsock communication with the guest.
	vsockPort = 1024
)

// vmInstance holds a running VM and its associated resources.
type vmInstance struct {
	vm           *vz.VirtualMachine
	config       *vz.VirtualMachineConfiguration
	socketDevice *vz.VirtioSocketDevice
	consoleRead  *os.File
	consoleWrite *os.File
	diskPath     string
	sessionID    string
	secret       string
	status       sandbox.Status
	createdAt    time.Time
	startedAt    *time.Time
	stoppedAt    *time.Time
	env          map[string]string
	metadata     map[string]string
	mu           sync.RWMutex
}

// Provider implements the sandbox.Provider interface using macOS Virtualization.framework.
type Provider struct {
	cfg *config.Config

	// vmInstances maps sessionID -> vmInstance
	vmInstances   map[string]*vmInstance
	vmInstancesMu sync.RWMutex

	// Event subscribers for Watch functionality
	subscribersMu sync.RWMutex
	subscribers   []*eventSubscriber

	// dataDir is where VM disk images and state are stored
	dataDir string

	// kernelPath is the path to the Linux kernel (vmlinuz)
	kernelPath string

	// initrdPath is the path to the initial ramdisk
	initrdPath string

	// baseDiskPath is the path to the base disk image to clone for new VMs
	baseDiskPath string
}

// Config holds vz-specific configuration.
type Config struct {
	// DataDir is the directory for VM disk images and state
	DataDir string

	// KernelPath is the path to the Linux kernel
	KernelPath string

	// InitrdPath is the path to the initial ramdisk
	InitrdPath string

	// BaseDiskPath is the path to the base disk image
	BaseDiskPath string
}

// NewProvider creates a new Virtualization.framework sandbox provider.
func NewProvider(cfg *config.Config, vzCfg *Config) (*Provider, error) {
	if vzCfg.DataDir == "" {
		return nil, fmt.Errorf("vz data directory is required")
	}

	if vzCfg.KernelPath == "" {
		return nil, fmt.Errorf("vz kernel path is required")
	}

	// Create data directory if it doesn't exist
	if err := os.MkdirAll(vzCfg.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create vz data directory: %w", err)
	}

	// Verify kernel exists
	if _, err := os.Stat(vzCfg.KernelPath); err != nil {
		return nil, fmt.Errorf("kernel not found at %s: %w", vzCfg.KernelPath, err)
	}

	// Verify initrd exists if specified
	if vzCfg.InitrdPath != "" {
		if _, err := os.Stat(vzCfg.InitrdPath); err != nil {
			return nil, fmt.Errorf("initrd not found at %s: %w", vzCfg.InitrdPath, err)
		}
	}

	// Verify base disk exists if specified
	if vzCfg.BaseDiskPath != "" {
		if _, err := os.Stat(vzCfg.BaseDiskPath); err != nil {
			return nil, fmt.Errorf("base disk not found at %s: %w", vzCfg.BaseDiskPath, err)
		}
	}

	p := &Provider{
		cfg:          cfg,
		vmInstances:  make(map[string]*vmInstance),
		dataDir:      vzCfg.DataDir,
		kernelPath:   vzCfg.KernelPath,
		initrdPath:   vzCfg.InitrdPath,
		baseDiskPath: vzCfg.BaseDiskPath,
	}

	// Load existing VM states from disk (recover from restart)
	states, err := p.loadAllStates()
	if err != nil {
		return nil, fmt.Errorf("failed to load existing VM states: %w", err)
	}

	for _, state := range states {
		// Verify disk image still exists
		if _, err := os.Stat(state.DiskPath); err != nil {
			// Disk is gone, clean up state file
			p.deleteState(state.SessionID)
			continue
		}

		instance := p.recoverFromState(state)
		p.vmInstances[state.SessionID] = instance

		// Update state file to reflect stopped status (if it was running)
		p.saveState(instance)
	}

	return p, nil
}

// vmName generates a consistent VM name from session ID.
func vmName(sessionID string) string {
	return fmt.Sprintf("octobot-session-%s", sessionID)
}

// diskImagePath returns the path to the disk image for a session.
func (p *Provider) diskImagePath(sessionID string) string {
	return filepath.Join(p.dataDir, fmt.Sprintf("%s.img", vmName(sessionID)))
}

// ImageExists checks if the configured sandbox image is available locally.
// For vz, this checks if the kernel and base disk are available.
func (p *Provider) ImageExists(ctx context.Context) bool {
	if _, err := os.Stat(p.kernelPath); err != nil {
		return false
	}
	if p.baseDiskPath != "" {
		if _, err := os.Stat(p.baseDiskPath); err != nil {
			return false
		}
	}
	return true
}

// Image returns the configured sandbox image name.
// For vz, this returns the kernel path as the "image".
func (p *Provider) Image() string {
	return p.kernelPath
}

// Create creates a new VM sandbox for the given session.
func (p *Provider) Create(ctx context.Context, sessionID string, opts sandbox.CreateOptions) (*sandbox.Sandbox, error) {
	p.vmInstancesMu.Lock()
	defer p.vmInstancesMu.Unlock()

	// Check if sandbox already exists
	if _, exists := p.vmInstances[sessionID]; exists {
		return nil, sandbox.ErrAlreadyExists
	}

	// Create disk image for this VM
	diskPath := p.diskImagePath(sessionID)
	if err := p.createDiskImage(diskPath, opts); err != nil {
		return nil, fmt.Errorf("%w: failed to create disk image: %v", sandbox.ErrStartFailed, err)
	}

	// Create metadata directory for VirtioFS sharing
	if err := p.createMetadata(sessionID, opts); err != nil {
		os.Remove(diskPath)
		return nil, fmt.Errorf("%w: failed to create metadata: %v", sandbox.ErrStartFailed, err)
	}

	// Build environment variables
	// WORKSPACE_PATH is always the mount point inside the VM
	// WORKSPACE_SOURCE is the original source (local path or git URL)
	env := make(map[string]string)

	// Add session ID (required by octobot-agent for AgentFS database naming)
	env["SESSION_ID"] = sessionID

	if opts.SharedSecret != "" {
		env["OCTOBOT_SECRET"] = hashSecret(opts.SharedSecret)
	}
	if opts.WorkspacePath != "" {
		env["WORKSPACE_PATH"] = workspacePath
	}
	if opts.WorkspaceSource != "" {
		env["WORKSPACE_SOURCE"] = opts.WorkspaceSource
	}
	if opts.WorkspaceCommit != "" {
		env["WORKSPACE_COMMIT"] = opts.WorkspaceCommit
	}

	// Prepare metadata
	metadata := map[string]string{
		"name":             vmName(sessionID),
		"octobot.managed":  "true",
		"octobot.session":  sessionID,
		"workspace.path":   opts.WorkspacePath,
		"workspace.commit": opts.WorkspaceCommit,
	}
	for k, v := range opts.Labels {
		metadata[k] = v
	}

	now := time.Now()
	instance := &vmInstance{
		diskPath:  diskPath,
		sessionID: sessionID,
		secret:    opts.SharedSecret,
		status:    sandbox.StatusCreated,
		createdAt: now,
		env:       env,
		metadata:  metadata,
	}

	p.vmInstances[sessionID] = instance

	// Persist state to disk
	if err := p.saveState(instance); err != nil {
		delete(p.vmInstances, sessionID)
		os.Remove(diskPath)
		return nil, fmt.Errorf("%w: failed to save state: %v", sandbox.ErrStartFailed, err)
	}

	// Emit state event
	p.emitEvent(sandbox.StateEvent{
		SessionID: sessionID,
		Status:    sandbox.StatusCreated,
		Timestamp: now,
	})

	return &sandbox.Sandbox{
		ID:        vmName(sessionID),
		SessionID: sessionID,
		Status:    sandbox.StatusCreated,
		Image:     p.kernelPath,
		CreatedAt: now,
		Metadata:  metadata,
		Env:       env,
		// Note: Communication is via vsock, not TCP ports.
		// Use provider.GetHTTPClient(sessionID) or provider.Dial(sessionID, port) to connect.
		Ports: []sandbox.AssignedPort{{
			ContainerPort: containerPort,
			HostPort:      0, // vsock - no host TCP port
			HostIP:        "vsock",
			Protocol:      "vsock",
		}},
	}, nil
}

// createDiskImage creates a disk image for a VM.
func (p *Provider) createDiskImage(diskPath string, opts sandbox.CreateOptions) error {
	if p.baseDiskPath != "" {
		// Clone base disk image
		src, err := os.Open(p.baseDiskPath)
		if err != nil {
			return fmt.Errorf("failed to open base disk: %w", err)
		}
		defer src.Close()

		dst, err := os.Create(diskPath)
		if err != nil {
			return fmt.Errorf("failed to create disk image: %w", err)
		}
		defer dst.Close()

		if _, err := io.Copy(dst, src); err != nil {
			os.Remove(diskPath)
			return fmt.Errorf("failed to copy base disk: %w", err)
		}
	} else {
		// Create empty disk image (10GB default)
		diskSize := int64(10 * 1024 * 1024 * 1024)
		if opts.Resources.DiskMB > 0 {
			diskSize = int64(opts.Resources.DiskMB) * 1024 * 1024
		}
		if err := vz.CreateDiskImage(diskPath, diskSize); err != nil {
			return fmt.Errorf("failed to create disk image: %w", err)
		}
	}
	return nil
}

// Start starts a previously created sandbox.
func (p *Provider) Start(ctx context.Context, sessionID string) error {
	p.vmInstancesMu.Lock()
	instance, exists := p.vmInstances[sessionID]
	p.vmInstancesMu.Unlock()

	if !exists {
		return sandbox.ErrNotFound
	}

	instance.mu.Lock()
	defer instance.mu.Unlock()

	if instance.status == sandbox.StatusRunning {
		return sandbox.ErrAlreadyRunning
	}

	// Build kernel command line
	cmdLine := []string{
		"console=hvc0",
		"root=/dev/vda",
		"rw",
	}

	// Add environment variables to kernel command line
	for k, v := range instance.env {
		cmdLine = append(cmdLine, fmt.Sprintf("%s=%s", k, v))
	}

	// Create boot loader
	bootLoaderOpts := []vz.LinuxBootLoaderOption{
		vz.WithCommandLine(strings.Join(cmdLine, " ")),
	}
	if p.initrdPath != "" {
		bootLoaderOpts = append(bootLoaderOpts, vz.WithInitrd(p.initrdPath))
	}

	bootLoader, err := vz.NewLinuxBootLoader(p.kernelPath, bootLoaderOpts...)
	if err != nil {
		return fmt.Errorf("%w: failed to create boot loader: %v", sandbox.ErrStartFailed, err)
	}

	// Determine CPU and memory
	cpuCount := uint(defaultCPUCount)
	memorySize := uint64(defaultMemoryBytes)

	// Create VM configuration
	vmConfig, err := vz.NewVirtualMachineConfiguration(bootLoader, cpuCount, memorySize)
	if err != nil {
		return fmt.Errorf("%w: failed to create VM config: %v", sandbox.ErrStartFailed, err)
	}

	// Configure storage
	diskAttachment, err := vz.NewDiskImageStorageDeviceAttachment(instance.diskPath, false)
	if err != nil {
		return fmt.Errorf("%w: failed to create disk attachment: %v", sandbox.ErrStartFailed, err)
	}

	storageConfig, err := vz.NewVirtioBlockDeviceConfiguration(diskAttachment)
	if err != nil {
		return fmt.Errorf("%w: failed to create storage config: %v", sandbox.ErrStartFailed, err)
	}
	vmConfig.SetStorageDevicesVirtualMachineConfiguration([]vz.StorageDeviceConfiguration{storageConfig})

	// Configure network with NAT
	natAttachment, err := vz.NewNATNetworkDeviceAttachment()
	if err != nil {
		return fmt.Errorf("%w: failed to create NAT attachment: %v", sandbox.ErrStartFailed, err)
	}

	networkConfig, err := vz.NewVirtioNetworkDeviceConfiguration(natAttachment)
	if err != nil {
		return fmt.Errorf("%w: failed to create network config: %v", sandbox.ErrStartFailed, err)
	}

	macAddr, err := vz.NewRandomLocallyAdministeredMACAddress()
	if err != nil {
		return fmt.Errorf("%w: failed to generate MAC address: %v", sandbox.ErrStartFailed, err)
	}
	networkConfig.SetMACAddress(macAddr)
	vmConfig.SetNetworkDevicesVirtualMachineConfiguration([]*vz.VirtioNetworkDeviceConfiguration{networkConfig})

	// Configure serial console using pipes
	consoleRead, consoleWriteHost, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("%w: failed to create console read pipe: %v", sandbox.ErrStartFailed, err)
	}
	consoleReadHost, consoleWrite, err := os.Pipe()
	if err != nil {
		consoleRead.Close()
		consoleWriteHost.Close()
		return fmt.Errorf("%w: failed to create console write pipe: %v", sandbox.ErrStartFailed, err)
	}

	serialAttachment, err := vz.NewFileHandleSerialPortAttachment(consoleReadHost, consoleWriteHost)
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		consoleReadHost.Close()
		consoleWriteHost.Close()
		return fmt.Errorf("%w: failed to create serial attachment: %v", sandbox.ErrStartFailed, err)
	}

	serialConfig, err := vz.NewVirtioConsoleDeviceSerialPortConfiguration(serialAttachment)
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		consoleReadHost.Close()
		consoleWriteHost.Close()
		return fmt.Errorf("%w: failed to create serial config: %v", sandbox.ErrStartFailed, err)
	}
	vmConfig.SetSerialPortsVirtualMachineConfiguration([]*vz.VirtioConsoleDeviceSerialPortConfiguration{serialConfig})

	// Configure vsock for command execution
	vsockConfig, err := vz.NewVirtioSocketDeviceConfiguration()
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return fmt.Errorf("%w: failed to create vsock config: %v", sandbox.ErrStartFailed, err)
	}
	vmConfig.SetSocketDevicesVirtualMachineConfiguration([]vz.SocketDeviceConfiguration{vsockConfig})

	// Configure entropy device
	entropyConfig, err := vz.NewVirtioEntropyDeviceConfiguration()
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return fmt.Errorf("%w: failed to create entropy config: %v", sandbox.ErrStartFailed, err)
	}
	vmConfig.SetEntropyDevicesVirtualMachineConfiguration([]*vz.VirtioEntropyDeviceConfiguration{entropyConfig})

	// Configure VirtioFS for metadata sharing
	metaDir := p.metadataDir(sessionID)
	sharedDir, err := vz.NewSharedDirectory(metaDir, true) // read-only
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return fmt.Errorf("%w: failed to create shared directory: %v", sandbox.ErrStartFailed, err)
	}

	dirShare, err := vz.NewSingleDirectoryShare(sharedDir)
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return fmt.Errorf("%w: failed to create directory share: %v", sandbox.ErrStartFailed, err)
	}

	fsConfig, err := vz.NewVirtioFileSystemDeviceConfiguration(MetadataTag)
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return fmt.Errorf("%w: failed to create virtio fs config: %v", sandbox.ErrStartFailed, err)
	}
	fsConfig.SetDirectoryShare(dirShare)
	vmConfig.SetDirectorySharingDevicesVirtualMachineConfiguration([]vz.DirectorySharingDeviceConfiguration{fsConfig})

	// Validate configuration
	valid, err := vmConfig.Validate()
	if err != nil || !valid {
		consoleRead.Close()
		consoleWrite.Close()
		return fmt.Errorf("%w: invalid VM configuration: %v", sandbox.ErrStartFailed, err)
	}

	// Create VM
	vm, err := vz.NewVirtualMachine(vmConfig)
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return fmt.Errorf("%w: failed to create VM: %v", sandbox.ErrStartFailed, err)
	}

	// Start VM
	if err := vm.Start(); err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return fmt.Errorf("%w: failed to start VM: %v", sandbox.ErrStartFailed, err)
	}

	// Get vsock device for later use
	socketDevices := vm.SocketDevices()
	var socketDevice *vz.VirtioSocketDevice
	if len(socketDevices) > 0 {
		socketDevice = socketDevices[0]
	}

	// Update instance
	now := time.Now()
	instance.vm = vm
	instance.config = vmConfig
	instance.socketDevice = socketDevice
	instance.consoleRead = consoleRead
	instance.consoleWrite = consoleWrite
	instance.status = sandbox.StatusRunning
	instance.startedAt = &now

	// Persist updated state
	p.saveState(instance)

	// Monitor VM state changes
	go p.monitorVM(sessionID, vm)

	return nil
}

// monitorVM monitors VM state changes and updates the instance status.
func (p *Provider) monitorVM(sessionID string, vm *vz.VirtualMachine) {
	for state := range vm.StateChangedNotify() {
		p.vmInstancesMu.RLock()
		instance, exists := p.vmInstances[sessionID]
		p.vmInstancesMu.RUnlock()

		if !exists {
			return
		}

		instance.mu.Lock()
		stateChanged := false
		var newStatus sandbox.Status
		var errMsg string
		switch state {
		case vz.VirtualMachineStateRunning:
			if instance.status != sandbox.StatusRunning {
				instance.status = sandbox.StatusRunning
				newStatus = sandbox.StatusRunning
				stateChanged = true
			}
		case vz.VirtualMachineStateStopped:
			if instance.status != sandbox.StatusStopped {
				now := time.Now()
				instance.status = sandbox.StatusStopped
				instance.stoppedAt = &now
				newStatus = sandbox.StatusStopped
				stateChanged = true
			}
		case vz.VirtualMachineStateError:
			if instance.status != sandbox.StatusFailed {
				now := time.Now()
				instance.status = sandbox.StatusFailed
				instance.stoppedAt = &now
				newStatus = sandbox.StatusFailed
				errMsg = "VM entered error state"
				stateChanged = true
			}
		}
		instance.mu.Unlock()

		// Persist state change to disk and emit event
		if stateChanged {
			p.saveState(instance)
			p.emitEvent(sandbox.StateEvent{
				SessionID: sessionID,
				Status:    newStatus,
				Timestamp: time.Now(),
				Error:     errMsg,
			})
		}
	}
}

// emitEvent sends an event to all subscribers.
func (p *Provider) emitEvent(event sandbox.StateEvent) {
	p.subscribersMu.RLock()
	defer p.subscribersMu.RUnlock()

	for _, sub := range p.subscribers {
		select {
		case sub.ch <- event:
		default:
			// Channel full, skip (non-blocking)
		}
	}
}

// Stop stops a running sandbox gracefully.
func (p *Provider) Stop(ctx context.Context, sessionID string, timeout time.Duration) error {
	p.vmInstancesMu.RLock()
	instance, exists := p.vmInstances[sessionID]
	p.vmInstancesMu.RUnlock()

	if !exists {
		return sandbox.ErrNotFound
	}

	instance.mu.Lock()
	defer instance.mu.Unlock()

	if instance.vm == nil || instance.status != sandbox.StatusRunning {
		return sandbox.ErrNotRunning
	}

	// Try graceful shutdown first
	if instance.vm.CanRequestStop() {
		stopped, err := instance.vm.RequestStop()
		if err == nil && stopped {
			// Wait for graceful shutdown
			timer := time.NewTimer(timeout)
			defer timer.Stop()

			for {
				select {
				case <-timer.C:
					// Timeout, force stop
					goto forceStop
				case <-ctx.Done():
					return ctx.Err()
				default:
					if instance.vm.State() == vz.VirtualMachineStateStopped {
						now := time.Now()
						instance.status = sandbox.StatusStopped
						instance.stoppedAt = &now
						p.saveState(instance)
						return nil
					}
					time.Sleep(100 * time.Millisecond)
				}
			}
		}
	}

forceStop:
	// Force stop
	if instance.vm.CanStop() {
		if err := instance.vm.Stop(); err != nil {
			return fmt.Errorf("failed to stop VM: %w", err)
		}
	}

	now := time.Now()
	instance.status = sandbox.StatusStopped
	instance.stoppedAt = &now

	// Persist state change
	p.saveState(instance)

	// Close console pipes
	if instance.consoleRead != nil {
		instance.consoleRead.Close()
	}
	if instance.consoleWrite != nil {
		instance.consoleWrite.Close()
	}

	return nil
}

// Remove removes a sandbox and its resources.
func (p *Provider) Remove(ctx context.Context, sessionID string, opts ...sandbox.RemoveOption) error {
	// VZ always removes disk, opts parameter ignored for consistency with interface
	p.vmInstancesMu.Lock()
	instance, exists := p.vmInstances[sessionID]
	if !exists {
		p.vmInstancesMu.Unlock()
		return nil // Already removed
	}
	delete(p.vmInstances, sessionID)
	p.vmInstancesMu.Unlock()

	instance.mu.Lock()
	defer instance.mu.Unlock()

	// Stop VM if running
	if instance.vm != nil && instance.status == sandbox.StatusRunning {
		if instance.vm.CanStop() {
			instance.vm.Stop()
		}
	}

	// Close console pipes
	if instance.consoleRead != nil {
		instance.consoleRead.Close()
	}
	if instance.consoleWrite != nil {
		instance.consoleWrite.Close()
	}

	// Remove disk image (always removed for VZ, removeVolumes param ignored)
	if instance.diskPath != "" {
		os.Remove(instance.diskPath)
	}

	// Remove state file
	p.deleteState(sessionID)

	// Remove metadata directory
	p.deleteMetadata(sessionID)

	// Emit state event
	p.emitEvent(sandbox.StateEvent{
		SessionID: sessionID,
		Status:    sandbox.StatusRemoved,
		Timestamp: time.Now(),
	})

	return nil
}

// Get returns the current state of a sandbox.
func (p *Provider) Get(ctx context.Context, sessionID string) (*sandbox.Sandbox, error) {
	p.vmInstancesMu.RLock()
	instance, exists := p.vmInstances[sessionID]
	p.vmInstancesMu.RUnlock()

	if !exists {
		return nil, sandbox.ErrNotFound
	}

	instance.mu.RLock()
	defer instance.mu.RUnlock()

	sb := &sandbox.Sandbox{
		ID:        vmName(sessionID),
		SessionID: sessionID,
		Status:    instance.status,
		Image:     p.kernelPath,
		CreatedAt: instance.createdAt,
		StartedAt: instance.startedAt,
		StoppedAt: instance.stoppedAt,
		Metadata:  instance.metadata,
		Env:       instance.env,
		// Note: Communication is via vsock, not TCP ports.
		// Use provider.GetHTTPClient(sessionID) or provider.Dial(sessionID, port) to connect.
		Ports: []sandbox.AssignedPort{{
			ContainerPort: containerPort,
			HostPort:      0, // vsock - no host TCP port
			HostIP:        "vsock",
			Protocol:      "vsock",
		}},
	}

	return sb, nil
}

// GetSecret returns the raw shared secret stored during sandbox creation.
func (p *Provider) GetSecret(ctx context.Context, sessionID string) (string, error) {
	p.vmInstancesMu.RLock()
	instance, exists := p.vmInstances[sessionID]
	p.vmInstancesMu.RUnlock()

	if !exists {
		return "", sandbox.ErrNotFound
	}

	instance.mu.RLock()
	defer instance.mu.RUnlock()

	if instance.secret == "" {
		return "", fmt.Errorf("shared secret not found for sandbox")
	}

	return instance.secret, nil
}

// List returns all sandboxes managed by octobot.
func (p *Provider) List(ctx context.Context) ([]*sandbox.Sandbox, error) {
	p.vmInstancesMu.RLock()
	defer p.vmInstancesMu.RUnlock()

	result := make([]*sandbox.Sandbox, 0, len(p.vmInstances))
	for sessionID, instance := range p.vmInstances {
		instance.mu.RLock()
		sb := &sandbox.Sandbox{
			ID:        vmName(sessionID),
			SessionID: sessionID,
			Status:    instance.status,
			Image:     p.kernelPath,
			CreatedAt: instance.createdAt,
			StartedAt: instance.startedAt,
			StoppedAt: instance.stoppedAt,
			Metadata:  instance.metadata,
			Env:       instance.env,
			Ports: []sandbox.AssignedPort{{
				ContainerPort: containerPort,
				HostPort:      0, // vsock - no host TCP port
				HostIP:        "vsock",
				Protocol:      "vsock",
			}},
		}
		instance.mu.RUnlock()
		result = append(result, sb)
	}

	return result, nil
}

// Exec runs a non-interactive command in the sandbox via vsock.
func (p *Provider) Exec(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecOptions) (*sandbox.ExecResult, error) {
	p.vmInstancesMu.RLock()
	instance, exists := p.vmInstances[sessionID]
	p.vmInstancesMu.RUnlock()

	if !exists {
		return nil, sandbox.ErrNotFound
	}

	instance.mu.RLock()
	if instance.status != sandbox.StatusRunning {
		instance.mu.RUnlock()
		return nil, sandbox.ErrNotRunning
	}
	socketDevice := instance.socketDevice
	instance.mu.RUnlock()

	if socketDevice == nil {
		return nil, fmt.Errorf("%w: vsock not available", sandbox.ErrExecFailed)
	}

	// Connect to guest agent via vsock
	conn, err := socketDevice.Connect(uint32(vsockPort))
	if err != nil {
		return nil, fmt.Errorf("%w: failed to connect to guest agent: %v", sandbox.ErrExecFailed, err)
	}
	defer conn.Close()

	// Build command request
	// Protocol: JSON-based simple command execution
	// Request: {"cmd": ["arg1", "arg2"], "env": {"KEY": "VALUE"}, "workdir": "/path"}
	// Response: {"exit_code": 0, "stdout": "base64", "stderr": "base64"}
	request := execRequest{
		Cmd:     cmd,
		Env:     opts.Env,
		WorkDir: opts.WorkDir,
		User:    opts.User,
	}

	if err := writeExecRequest(conn, &request); err != nil {
		return nil, fmt.Errorf("%w: failed to send command: %v", sandbox.ErrExecFailed, err)
	}

	// Handle stdin if provided
	if opts.Stdin != nil {
		go func() {
			io.Copy(conn, opts.Stdin)
		}()
	}

	// Read response
	response, err := readExecResponse(conn)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read response: %v", sandbox.ErrExecFailed, err)
	}

	return &sandbox.ExecResult{
		ExitCode: response.ExitCode,
		Stdout:   response.Stdout,
		Stderr:   response.Stderr,
	}, nil
}

// Attach creates an interactive PTY session to the sandbox.
func (p *Provider) Attach(ctx context.Context, sessionID string, opts sandbox.AttachOptions) (sandbox.PTY, error) {
	p.vmInstancesMu.RLock()
	instance, exists := p.vmInstances[sessionID]
	p.vmInstancesMu.RUnlock()

	if !exists {
		return nil, sandbox.ErrNotFound
	}

	instance.mu.RLock()
	if instance.status != sandbox.StatusRunning {
		instance.mu.RUnlock()
		return nil, sandbox.ErrNotRunning
	}
	socketDevice := instance.socketDevice
	instance.mu.RUnlock()

	if socketDevice == nil {
		return nil, fmt.Errorf("%w: vsock not available", sandbox.ErrAttachFailed)
	}

	// Connect to guest agent via vsock for PTY
	conn, err := socketDevice.Connect(uint32(vsockPort + 1)) // Use different port for PTY
	if err != nil {
		return nil, fmt.Errorf("%w: failed to connect to guest agent: %v", sandbox.ErrAttachFailed, err)
	}

	// Default to bash shell
	cmd := opts.Cmd
	if len(cmd) == 0 {
		cmd = []string{"/bin/bash"}
	}

	// Send PTY request
	request := ptyRequest{
		Cmd:  cmd,
		Env:  opts.Env,
		Rows: opts.Rows,
		Cols: opts.Cols,
	}

	if err := writePTYRequest(conn, &request); err != nil {
		conn.Close()
		return nil, fmt.Errorf("%w: failed to send PTY request: %v", sandbox.ErrAttachFailed, err)
	}

	return &vzPTY{
		conn:      conn,
		closeOnce: sync.Once{},
	}, nil
}

// ExecStream runs a command with bidirectional streaming I/O (no TTY).
func (p *Provider) ExecStream(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecStreamOptions) (sandbox.Stream, error) {
	p.vmInstancesMu.RLock()
	instance, exists := p.vmInstances[sessionID]
	p.vmInstancesMu.RUnlock()

	if !exists {
		return nil, sandbox.ErrNotFound
	}

	instance.mu.RLock()
	if instance.status != sandbox.StatusRunning {
		instance.mu.RUnlock()
		return nil, sandbox.ErrNotRunning
	}
	socketDevice := instance.socketDevice
	instance.mu.RUnlock()

	if socketDevice == nil {
		return nil, fmt.Errorf("vsock not available")
	}

	// Connect to guest agent via vsock for streaming exec
	conn, err := socketDevice.Connect(uint32(vsockPort + 2)) // Use different port for stream
	if err != nil {
		return nil, fmt.Errorf("failed to connect to guest agent: %v", err)
	}

	// Send stream exec request (similar to PTY but with Tty=false)
	request := ptyRequest{
		Cmd:  cmd,
		Env:  opts.Env,
		Rows: 0, // No terminal dimensions for stream
		Cols: 0,
	}

	if err := writePTYRequest(conn, &request); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to send stream request: %v", err)
	}

	return &vzStream{
		conn:      conn,
		closeOnce: sync.Once{},
	}, nil
}

// Close closes the provider and cleans up resources.
func (p *Provider) Close() error {
	p.vmInstancesMu.Lock()
	defer p.vmInstancesMu.Unlock()

	for sessionID, instance := range p.vmInstances {
		instance.mu.Lock()
		if instance.vm != nil && instance.status == sandbox.StatusRunning {
			if instance.vm.CanStop() {
				instance.vm.Stop()
			}
		}
		if instance.consoleRead != nil {
			instance.consoleRead.Close()
		}
		if instance.consoleWrite != nil {
			instance.consoleWrite.Close()
		}
		instance.mu.Unlock()
		delete(p.vmInstances, sessionID)
	}

	return nil
}

// hashSecret creates a salted SHA-256 hash of the secret.
func hashSecret(secret string) string {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		salt = make([]byte, 16)
	}
	h := sha256.New()
	h.Write(salt)
	h.Write([]byte(secret))
	return hex.EncodeToString(salt) + ":" + hex.EncodeToString(h.Sum(nil))
}

// vzPTY implements sandbox.PTY for vz VM sessions.
type vzPTY struct {
	conn      *vz.VirtioSocketConnection
	closeOnce sync.Once
}

func (p *vzPTY) Read(b []byte) (int, error) {
	return p.conn.Read(b)
}

func (p *vzPTY) Write(b []byte) (int, error) {
	return p.conn.Write(b)
}

func (p *vzPTY) Resize(ctx context.Context, rows, cols int) error {
	// Send resize command over the connection
	// This requires the guest agent to handle resize requests
	resizeCmd := fmt.Sprintf("\x1b[8;%d;%dt", rows, cols)
	_, err := p.conn.Write([]byte(resizeCmd))
	return err
}

func (p *vzPTY) Close() error {
	var err error
	p.closeOnce.Do(func() {
		err = p.conn.Close()
	})
	return err
}

func (p *vzPTY) Wait(ctx context.Context) (int, error) {
	// Wait for the connection to close
	buf := make([]byte, 1)
	for {
		select {
		case <-ctx.Done():
			return -1, ctx.Err()
		default:
			_, err := p.conn.Read(buf)
			if err != nil {
				if err == io.EOF {
					return 0, nil
				}
				return -1, err
			}
		}
	}
}

// vzStream implements sandbox.Stream for vz VM sessions without TTY.
type vzStream struct {
	conn      io.ReadWriteCloser
	closeOnce sync.Once
}

func (s *vzStream) Read(b []byte) (int, error) {
	return s.conn.Read(b)
}

func (s *vzStream) Stderr() io.Reader {
	// VZ streams don't have separate stderr - it's merged with stdout
	return nil
}

func (s *vzStream) Write(b []byte) (int, error) {
	return s.conn.Write(b)
}

func (s *vzStream) CloseWrite() error {
	// Try to close write side if supported
	if cw, ok := s.conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return nil
}

func (s *vzStream) Close() error {
	var err error
	s.closeOnce.Do(func() {
		err = s.conn.Close()
	})
	return err
}

func (s *vzStream) Wait(ctx context.Context) (int, error) {
	// Wait for the connection to close
	buf := make([]byte, 1)
	for {
		select {
		case <-ctx.Done():
			return -1, ctx.Err()
		default:
			_, err := s.conn.Read(buf)
			if err != nil {
				if err == io.EOF {
					return 0, nil
				}
				return -1, err
			}
		}
	}
}

// execRequest is the request format for command execution.
type execRequest struct {
	Cmd     []string          `json:"cmd"`
	Env     map[string]string `json:"env,omitempty"`
	WorkDir string            `json:"workdir,omitempty"`
	User    string            `json:"user,omitempty"`
}

// execResponse is the response format for command execution.
type execResponse struct {
	ExitCode int    `json:"exit_code"`
	Stdout   []byte `json:"stdout"`
	Stderr   []byte `json:"stderr"`
}

// ptyRequest is the request format for PTY sessions.
type ptyRequest struct {
	Cmd  []string          `json:"cmd"`
	Env  map[string]string `json:"env,omitempty"`
	Rows int               `json:"rows"`
	Cols int               `json:"cols"`
}

// writeExecRequest writes an exec request to the connection.
func writeExecRequest(conn *vz.VirtioSocketConnection, req *execRequest) error {
	// Simple length-prefixed JSON protocol
	data, err := encodeJSON(req)
	if err != nil {
		return err
	}
	return writeFrame(conn, data)
}

// readExecResponse reads an exec response from the connection.
func readExecResponse(conn *vz.VirtioSocketConnection) (*execResponse, error) {
	data, err := readFrame(conn)
	if err != nil {
		return nil, err
	}
	var resp execResponse
	if err := decodeJSON(data, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// writePTYRequest writes a PTY request to the connection.
func writePTYRequest(conn *vz.VirtioSocketConnection, req *ptyRequest) error {
	data, err := encodeJSON(req)
	if err != nil {
		return err
	}
	return writeFrame(conn, data)
}

// writeFrame writes a length-prefixed frame.
func writeFrame(w io.Writer, data []byte) error {
	// 4-byte big-endian length prefix
	length := uint32(len(data))
	buf := make([]byte, 4+len(data))
	buf[0] = byte(length >> 24)
	buf[1] = byte(length >> 16)
	buf[2] = byte(length >> 8)
	buf[3] = byte(length)
	copy(buf[4:], data)
	_, err := w.Write(buf)
	return err
}

// readFrame reads a length-prefixed frame.
func readFrame(r io.Reader) ([]byte, error) {
	// Read 4-byte length prefix
	lenBuf := make([]byte, 4)
	if _, err := io.ReadFull(r, lenBuf); err != nil {
		return nil, err
	}
	length := uint32(lenBuf[0])<<24 | uint32(lenBuf[1])<<16 | uint32(lenBuf[2])<<8 | uint32(lenBuf[3])

	// Read data
	data := make([]byte, length)
	if _, err := io.ReadFull(r, data); err != nil {
		return nil, err
	}
	return data, nil
}

// encodeJSON encodes a value to JSON bytes.
func encodeJSON(v interface{}) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// decodeJSON decodes JSON bytes to a value.
func decodeJSON(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

// Watch returns a channel that receives sandbox state change events.
// For the VZ provider, this replays current state and then streams events
// as VM state changes occur through the internal VM monitoring.
func (p *Provider) Watch(ctx context.Context) (<-chan sandbox.StateEvent, error) {
	eventCh := make(chan sandbox.StateEvent, 100)
	done := make(chan struct{})

	sub := &eventSubscriber{
		ch:   eventCh,
		done: done,
	}

	// Register subscriber
	p.subscribersMu.Lock()
	p.subscribers = append(p.subscribers, sub)
	p.subscribersMu.Unlock()

	// Start goroutine to handle replay and context cancellation
	go func() {
		defer func() {
			// Unregister subscriber on exit
			p.subscribersMu.Lock()
			for i, s := range p.subscribers {
				if s == sub {
					p.subscribers = append(p.subscribers[:i], p.subscribers[i+1:]...)
					break
				}
			}
			p.subscribersMu.Unlock()
			close(eventCh)
		}()

		// Replay current state
		sandboxes, err := p.List(ctx)
		if err != nil {
			log.Printf("Watch: failed to list VMs for replay: %v", err)
			// Continue anyway - we can still watch for new events
		} else {
			for _, sb := range sandboxes {
				select {
				case <-ctx.Done():
					return
				case eventCh <- sandbox.StateEvent{
					SessionID: sb.SessionID,
					Status:    sb.Status,
					Timestamp: time.Now(),
					Error:     sb.Error,
				}:
				}
			}
		}

		// Wait for context cancellation or done signal
		select {
		case <-ctx.Done():
		case <-done:
		}
	}()

	return eventCh, nil
}
