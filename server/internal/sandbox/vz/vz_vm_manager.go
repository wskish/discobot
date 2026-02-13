//go:build darwin

package vz

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/Code-Hex/vz/v3"

	"github.com/obot-platform/discobot/server/internal/sandbox/vm"
)

const (
	// dockerSockPort is the VSOCK port for accessing Docker socket inside the VM.
	dockerSockPort = 2375

	// defaultDataDiskGB is the default data disk size for VMs (100GB).
	defaultDataDiskGB = 100
)

// getDefaultMemoryBytes returns the default memory for VMs.
// It calculates half of the system's total physical memory, rounded down to the nearest gigabyte.
// If the system memory cannot be determined, it falls back to 8GB.
func getDefaultMemoryBytes() uint64 {
	// Use sysctl to get total physical memory on macOS
	mib := []int32{6 /* CTL_HW */, 24 /* HW_MEMSIZE */}
	var memSize uint64

	n := uintptr(8) // size of uint64
	_, _, errno := syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])),
		uintptr(len(mib)),
		uintptr(unsafe.Pointer(&memSize)),
		uintptr(unsafe.Pointer(&n)),
		0,
		0,
	)

	if errno != 0 {
		// Fallback to 8GB if we can't get system memory
		log.Printf("Failed to get system memory, using 8GB default: %v", errno)
		return 8 * 1024 * 1024 * 1024
	}

	// Calculate half of system memory
	halfMemory := memSize / 2

	// Round down to nearest gigabyte
	oneGB := uint64(1024 * 1024 * 1024)
	roundedMemory := (halfMemory / oneGB) * oneGB

	log.Printf("System memory: %d GB, default VM memory: %d GB",
		memSize/(1024*1024*1024),
		roundedMemory/(1024*1024*1024))

	return roundedMemory
}

// vzProjectVM implements vm.ProjectVM for Apple Virtualization framework.
type vzProjectVM struct {
	projectID    string
	vm           *vz.VirtualMachine
	socketDevice *vz.VirtioSocketDevice
	dataDiskPath string   // Data disk (writable)
	consoleLog   *os.File // Console log file

	// Session reference counting
	sessions   map[string]bool
	sessionsMu sync.RWMutex

	// isWarm indicates this VM was pre-warmed at startup without sessions.
	// Warm VMs are not subject to idle cleanup until a session has been
	// added and then removed (at which point isWarm is cleared).
	isWarm bool

	// Lifecycle
	createdAt  time.Time
	lastUsedAt time.Time
	mu         sync.RWMutex
}

// ProjectID returns the project ID this VM serves.
func (pvm *vzProjectVM) ProjectID() string {
	return pvm.projectID
}

// AddSession registers a session with this VM.
func (pvm *vzProjectVM) AddSession(sessionID string) {
	pvm.sessionsMu.Lock()
	defer pvm.sessionsMu.Unlock()

	pvm.sessions[sessionID] = true
	pvm.lastUsedAt = time.Now()
	pvm.isWarm = false // No longer warm-only once a real session is added
}

// RemoveSession unregisters a session from this VM.
func (pvm *vzProjectVM) RemoveSession(sessionID string) {
	pvm.sessionsMu.Lock()
	defer pvm.sessionsMu.Unlock()

	delete(pvm.sessions, sessionID)
	pvm.lastUsedAt = time.Now()
}

// SessionCount returns the number of active sessions using this VM.
func (pvm *vzProjectVM) SessionCount() int {
	pvm.sessionsMu.RLock()
	defer pvm.sessionsMu.RUnlock()

	return len(pvm.sessions)
}

// DockerDialer returns a VSOCK dialer function for Docker client.
func (pvm *vzProjectVM) DockerDialer() func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(_ context.Context, _, _ string) (net.Conn, error) {
		pvm.mu.RLock()
		socketDevice := pvm.socketDevice
		pvm.mu.RUnlock()

		if socketDevice == nil {
			return nil, fmt.Errorf("vsock not available for project VM %s", pvm.projectID)
		}

		conn, err := socketDevice.Connect(dockerSockPort)
		if err != nil {
			return nil, fmt.Errorf("failed to connect to vsock port %d: %w", dockerSockPort, err)
		}

		return &vsockConn{
			VirtioSocketConnection: conn,
			localAddr:              &vsockAddr{cid: 2, port: 0},
			remoteAddr:             &vsockAddr{cid: 3, port: dockerSockPort},
		}, nil
	}
}

// PortDialer returns a VSOCK dialer function for an arbitrary port.
func (pvm *vzProjectVM) PortDialer(port uint32) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(_ context.Context, _, _ string) (net.Conn, error) {
		pvm.mu.RLock()
		socketDevice := pvm.socketDevice
		pvm.mu.RUnlock()

		if socketDevice == nil {
			return nil, fmt.Errorf("vsock not available for project VM %s", pvm.projectID)
		}

		conn, err := socketDevice.Connect(port)
		if err != nil {
			return nil, fmt.Errorf("vsock connect port %d: %w", port, err)
		}

		return &vsockConn{
			VirtioSocketConnection: conn,
			localAddr:              &vsockAddr{cid: 2, port: 0},
			remoteAddr:             &vsockAddr{cid: 3, port: port},
		}, nil
	}
}

// Shutdown gracefully stops the VM.
func (pvm *vzProjectVM) Shutdown() error {
	pvm.mu.Lock()
	defer pvm.mu.Unlock()

	if pvm.vm != nil {
		if err := pvm.vm.Stop(); err != nil {
			return err
		}
	}

	// Close console log file
	if pvm.consoleLog != nil {
		pvm.consoleLog.Close()
	}

	return nil
}

// VMManager implements vm.ProjectVMManager for Apple Virtualization framework.
type VMManager struct {
	config vm.Config

	// projectVMs maps projectID -> vzProjectVM
	projectVMs  map[string]*vzProjectVM
	projectVMMu sync.RWMutex

	// Idle timeout before VM shutdown (0 = never shutdown)
	idleTimeout time.Duration

	// Shutdown signal
	stopCh chan struct{}
	wg     sync.WaitGroup
}

// NewVMManager creates a new VZ VM manager.
func NewVMManager(config vm.Config) (*VMManager, error) {
	// Parse idle timeout
	idleTimeout := 30 * time.Minute // default
	if config.IdleTimeout != "" {
		parsed, err := time.ParseDuration(config.IdleTimeout)
		if err != nil {
			return nil, fmt.Errorf("invalid idle timeout: %w", err)
		}
		idleTimeout = parsed
	}

	mgr := &VMManager{
		config:      config,
		projectVMs:  make(map[string]*vzProjectVM),
		idleTimeout: idleTimeout,
		stopCh:      make(chan struct{}),
	}

	// Start background cleanup goroutine if idle timeout is set
	if idleTimeout > 0 {
		mgr.wg.Add(1)
		go mgr.cleanupIdleVMs()
	}

	return mgr, nil
}

// GetOrCreateVM returns an existing VM for the project or creates a new one.
func (m *VMManager) GetOrCreateVM(ctx context.Context, projectID, sessionID string) (vm.ProjectVM, error) {
	m.projectVMMu.Lock()
	defer m.projectVMMu.Unlock()

	pvm, exists := m.projectVMs[projectID]
	if exists {
		// Add session to existing VM
		pvm.AddSession(sessionID)
		sessionCount := pvm.SessionCount()

		log.Printf("Project VM %s: added session %s (total sessions: %d)", projectID, sessionID, sessionCount)
		return pvm, nil
	}

	// Create new VM for project
	log.Printf("Creating new project VM for project: %s", projectID)
	pvm, err := m.createProjectVM(ctx, projectID, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to create project VM: %w", err)
	}

	m.projectVMs[projectID] = pvm
	log.Printf("Project VM %s created successfully", projectID)
	return pvm, nil
}

// GetVM returns the VM for the given project, if it exists.
func (m *VMManager) GetVM(projectID string) (vm.ProjectVM, bool) {
	m.projectVMMu.RLock()
	defer m.projectVMMu.RUnlock()

	pvm, exists := m.projectVMs[projectID]
	if !exists {
		return nil, false
	}
	return pvm, true
}

// WarmVM creates a VM for the project without associating any sessions.
// This is used at startup to pre-warm VMs so they're ready when sessions are created.
func (m *VMManager) WarmVM(ctx context.Context, projectID string) (vm.ProjectVM, error) {
	m.projectVMMu.Lock()
	defer m.projectVMMu.Unlock()

	if pvm, exists := m.projectVMs[projectID]; exists {
		log.Printf("Project VM %s already exists, skipping warm", projectID)
		return pvm, nil
	}

	log.Printf("Warming project VM for project: %s", projectID)
	pvm, err := m.createProjectVM(ctx, projectID, "")
	if err != nil {
		return nil, fmt.Errorf("failed to warm project VM: %w", err)
	}

	m.projectVMs[projectID] = pvm
	log.Printf("Project VM %s warmed successfully", projectID)
	return pvm, nil
}

// RemoveSession removes a session from the project VM.
func (m *VMManager) RemoveSession(projectID, sessionID string) error {
	m.projectVMMu.RLock()
	pvm, exists := m.projectVMs[projectID]
	m.projectVMMu.RUnlock()

	if !exists {
		return fmt.Errorf("project VM not found: %s", projectID)
	}

	pvm.RemoveSession(sessionID)
	sessionCount := pvm.SessionCount()

	if sessionCount == 0 {
		log.Printf("Project VM %s has no active sessions, will idle", projectID)
	} else {
		log.Printf("Project VM %s: removed session %s (%d sessions remaining)", projectID, sessionID, sessionCount)
	}

	return nil
}

// Shutdown stops all project VMs and shuts down the manager.
func (m *VMManager) Shutdown() {
	close(m.stopCh)

	// Stop all VMs
	m.projectVMMu.Lock()
	for projectID, pvm := range m.projectVMs {
		log.Printf("Shutting down project VM: %s", projectID)
		if err := pvm.Shutdown(); err != nil {
			log.Printf("Error stopping project VM %s: %v", projectID, err)
		}
	}
	m.projectVMs = make(map[string]*vzProjectVM)
	m.projectVMMu.Unlock()

	// Wait for cleanup goroutine
	m.wg.Wait()
}

// createProjectVM creates and starts a new VM for a project.
func (m *VMManager) createProjectVM(ctx context.Context, projectID, sessionID string) (*vzProjectVM, error) {
	// Root disk (read-only) - use the base disk directly, shared across all VMs
	rootDiskPath := m.config.BaseDiskPath

	// Data disk (writable) - per-project persistent storage
	dataDiskPath := filepath.Join(m.config.DataDir, fmt.Sprintf("project-%s-data.img", projectID))

	log.Printf("Using shared base disk (read-only): %s", rootDiskPath)

	// Create data disk if it doesn't exist
	if _, err := os.Stat(dataDiskPath); os.IsNotExist(err) {
		diskGB := defaultDataDiskGB
		if m.config.DataDiskGB > 0 {
			diskGB = m.config.DataDiskGB
		}
		dataDiskSize := int64(diskGB) * 1024 * 1024 * 1024
		if err := vz.CreateDiskImage(dataDiskPath, dataDiskSize); err != nil {
			return nil, fmt.Errorf("failed to create data disk: %w", err)
		}
		log.Printf("Created data disk: %s", dataDiskPath)
	}

	// Create console log file
	consoleLogPath := filepath.Join(m.config.ConsoleLogDir, fmt.Sprintf("project-%s", projectID), "console.log")
	if err := os.MkdirAll(filepath.Dir(consoleLogPath), 0755); err != nil {
		return nil, fmt.Errorf("failed to create console log directory: %w", err)
	}

	consoleLog, err := os.OpenFile(consoleLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("failed to create console log file: %w", err)
	}

	log.Printf("Console log: %s", consoleLogPath)

	// Build and start VM
	vzVM, socketDevice, consoleRead, consoleWrite, err := m.buildAndStartVM(rootDiskPath, dataDiskPath, projectID)
	if err != nil {
		consoleLog.Close()
		return nil, fmt.Errorf("failed to build and start VM: %w", err)
	}

	log.Printf("Started project VM for: %s", projectID)

	// Log console output to file and also to main log
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := consoleRead.Read(buf)
			if err != nil {
				return
			}
			if n > 0 {
				// Write to file
				_, _ = consoleLog.Write(buf[:n])
				// Also log to main logger (with prefix)
				log.Printf("[VM %s] %s", projectID, string(buf[:n]))
			}
		}
	}()

	log.Printf("Waiting for Docker daemon to be ready in VM: %s", projectID)

	// Wait for Docker daemon to be ready
	if err := m.waitForDocker(ctx, socketDevice, projectID); err != nil {
		_ = vzVM.Stop()
		consoleRead.Close()
		consoleWrite.Close()
		consoleLog.Close()
		return nil, fmt.Errorf("docker daemon not ready: %w", err)
	}

	log.Printf("Docker daemon ready in VM: %s", projectID)

	sessions := make(map[string]bool)
	if sessionID != "" {
		sessions[sessionID] = true
	}

	pvm := &vzProjectVM{
		projectID:    projectID,
		vm:           vzVM,
		socketDevice: socketDevice,
		dataDiskPath: dataDiskPath,
		consoleLog:   consoleLog,
		sessions:     sessions,
		isWarm:       sessionID == "",
		createdAt:    time.Now(),
		lastUsedAt:   time.Now(),
	}

	return pvm, nil
}

// cloneDisk copies the base disk to a new location.
// buildAndStartVM creates and starts a VM with the given disk images.
// rootDiskPath is mounted read-only as /dev/vda, dataDiskPath is mounted read-write as /dev/vdb.
func (m *VMManager) buildAndStartVM(rootDiskPath, dataDiskPath, _ string) (*vz.VirtualMachine, *vz.VirtioSocketDevice, *os.File, *os.File, error) {
	// Build kernel command line
	// Root disk is read-only, data disk (/dev/vdb) is where writable data goes
	cmdLine := []string{
		"console=hvc0",
		"root=/dev/vda",
		"rootfstype=squashfs", // SquashFS root filesystem
		"ro",                  // Read-only root filesystem
	}

	// Pass host home directory path to guest via kernel cmdline
	if m.config.HomeDir != "" {
		cmdLine = append(cmdLine, fmt.Sprintf("discobot.homedir=%s", m.config.HomeDir))
	}

	// Create boot loader
	bootLoaderOpts := []vz.LinuxBootLoaderOption{
		vz.WithCommandLine(strings.Join(cmdLine, " ")),
	}
	if m.config.InitrdPath != "" {
		bootLoaderOpts = append(bootLoaderOpts, vz.WithInitrd(m.config.InitrdPath))
	}

	bootLoader, err := vz.NewLinuxBootLoader(m.config.KernelPath, bootLoaderOpts...)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to create boot loader: %w", err)
	}

	// Determine CPU and memory (default to all host CPUs)
	cpuCount := uint(runtime.NumCPU())
	if m.config.CPUCount > 0 {
		cpuCount = uint(m.config.CPUCount)
	}

	memorySize := getDefaultMemoryBytes()
	if m.config.MemoryMB > 0 {
		memorySize = uint64(m.config.MemoryMB) * 1024 * 1024
	}

	// Create VM configuration
	vmConfig, err := vz.NewVirtualMachineConfiguration(bootLoader, cpuCount, memorySize)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to create VM config: %w", err)
	}

	// Configure storage devices
	var storageDevices []vz.StorageDeviceConfiguration

	// Root disk (read-only) - /dev/vda
	rootDiskAttachment, err := vz.NewDiskImageStorageDeviceAttachment(rootDiskPath, true) // true = read-only
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to create root disk attachment: %w", err)
	}

	rootStorageConfig, err := vz.NewVirtioBlockDeviceConfiguration(rootDiskAttachment)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to create root storage config: %w", err)
	}
	storageDevices = append(storageDevices, rootStorageConfig)

	// Data disk (read-write) - /dev/vdb
	dataDiskAttachment, err := vz.NewDiskImageStorageDeviceAttachment(dataDiskPath, false) // false = read-write
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to create data disk attachment: %w", err)
	}

	dataStorageConfig, err := vz.NewVirtioBlockDeviceConfiguration(dataDiskAttachment)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to create data storage config: %w", err)
	}
	storageDevices = append(storageDevices, dataStorageConfig)

	vmConfig.SetStorageDevicesVirtualMachineConfiguration(storageDevices)

	// Configure network with NAT
	natAttachment, err := vz.NewNATNetworkDeviceAttachment()
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to create NAT attachment: %w", err)
	}

	networkConfig, err := vz.NewVirtioNetworkDeviceConfiguration(natAttachment)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to create network config: %w", err)
	}

	macAddr, err := vz.NewRandomLocallyAdministeredMACAddress()
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to generate MAC address: %w", err)
	}
	networkConfig.SetMACAddress(macAddr)
	vmConfig.SetNetworkDevicesVirtualMachineConfiguration([]*vz.VirtioNetworkDeviceConfiguration{networkConfig})

	// Configure serial console
	consoleRead, consoleWriteHost, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to create console read pipe: %w", err)
	}
	consoleReadHost, consoleWrite, err := os.Pipe()
	if err != nil {
		consoleRead.Close()
		consoleWriteHost.Close()
		return nil, nil, nil, nil, fmt.Errorf("failed to create console write pipe: %w", err)
	}

	serialAttachment, err := vz.NewFileHandleSerialPortAttachment(consoleReadHost, consoleWriteHost)
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		consoleReadHost.Close()
		consoleWriteHost.Close()
		return nil, nil, nil, nil, fmt.Errorf("failed to create serial attachment: %w", err)
	}

	serialConfig, err := vz.NewVirtioConsoleDeviceSerialPortConfiguration(serialAttachment)
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		consoleReadHost.Close()
		consoleWriteHost.Close()
		return nil, nil, nil, nil, fmt.Errorf("failed to create serial config: %w", err)
	}
	vmConfig.SetSerialPortsVirtualMachineConfiguration([]*vz.VirtioConsoleDeviceSerialPortConfiguration{serialConfig})

	// Configure vsock
	vsockConfig, err := vz.NewVirtioSocketDeviceConfiguration()
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return nil, nil, nil, nil, fmt.Errorf("failed to create vsock config: %w", err)
	}
	vmConfig.SetSocketDevicesVirtualMachineConfiguration([]vz.SocketDeviceConfiguration{vsockConfig})

	// Configure entropy device
	entropyConfig, err := vz.NewVirtioEntropyDeviceConfiguration()
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return nil, nil, nil, nil, fmt.Errorf("failed to create entropy config: %w", err)
	}
	vmConfig.SetEntropyDevicesVirtualMachineConfiguration([]*vz.VirtioEntropyDeviceConfiguration{entropyConfig})

	// Configure VirtioFS shared directory (host home directory, read-only)
	if m.config.HomeDir != "" {
		sharedDir, err := vz.NewSharedDirectory(m.config.HomeDir, true) // true = read-only
		if err != nil {
			consoleRead.Close()
			consoleWrite.Close()
			return nil, nil, nil, nil, fmt.Errorf("failed to create shared directory: %w", err)
		}

		dirShare, err := vz.NewSingleDirectoryShare(sharedDir)
		if err != nil {
			consoleRead.Close()
			consoleWrite.Close()
			return nil, nil, nil, nil, fmt.Errorf("failed to create directory share: %w", err)
		}

		fsDeviceConfig, err := vz.NewVirtioFileSystemDeviceConfiguration("home")
		if err != nil {
			consoleRead.Close()
			consoleWrite.Close()
			return nil, nil, nil, nil, fmt.Errorf("failed to create VirtioFS device config: %w", err)
		}
		fsDeviceConfig.SetDirectoryShare(dirShare)

		vmConfig.SetDirectorySharingDevicesVirtualMachineConfiguration(
			[]vz.DirectorySharingDeviceConfiguration{fsDeviceConfig},
		)

		log.Printf("VirtioFS: sharing %s as read-only (tag: home)", m.config.HomeDir)
	}

	// Validate configuration
	valid, err := vmConfig.Validate()
	if err != nil || !valid {
		consoleRead.Close()
		consoleWrite.Close()
		return nil, nil, nil, nil, fmt.Errorf("invalid VM configuration: %w", err)
	}

	// Create VM
	vzVM, err := vz.NewVirtualMachine(vmConfig)
	if err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return nil, nil, nil, nil, fmt.Errorf("failed to create VM: %w", err)
	}

	// Start VM
	if err := vzVM.Start(); err != nil {
		consoleRead.Close()
		consoleWrite.Close()
		return nil, nil, nil, nil, fmt.Errorf("failed to start VM: %w", err)
	}

	// Get vsock device
	socketDevices := vzVM.SocketDevices()
	var socketDevice *vz.VirtioSocketDevice
	if len(socketDevices) > 0 {
		socketDevice = socketDevices[0]
	}

	return vzVM, socketDevice, consoleRead, consoleWrite, nil
}

// waitForDocker waits for Docker daemon to be ready inside the VM.
func (m *VMManager) waitForDocker(ctx context.Context, socketDevice *vz.VirtioSocketDevice, projectID string) error {
	deadline := time.Now().Add(60 * time.Second)
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if time.Now().After(deadline) {
				return fmt.Errorf("timeout waiting for Docker daemon")
			}

			// Try to ping Docker API
			conn, err := socketDevice.Connect(dockerSockPort)
			if err != nil {
				log.Printf("Project VM %s: waiting for Docker (connect failed: %v)", projectID, err)
				continue
			}

			// Create vsock connection wrapper
			vsockConn := &vsockConn{
				VirtioSocketConnection: conn,
				localAddr:              &vsockAddr{cid: 2, port: 0},
				remoteAddr:             &vsockAddr{cid: 3, port: dockerSockPort},
			}

			// Send Docker ping request
			client := &http.Client{
				Transport: &http.Transport{
					DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
						return vsockConn, nil
					},
				},
				Timeout: 3 * time.Second,
			}

			resp, err := client.Get("http://localhost/_ping")
			if err != nil {
				vsockConn.Close()
				log.Printf("Project VM %s: waiting for Docker (ping failed: %v)", projectID, err)
				continue
			}
			resp.Body.Close()

			if resp.StatusCode == http.StatusOK {
				vsockConn.Close()
				log.Printf("Project VM %s: Docker daemon is ready", projectID)
				return nil
			}

			vsockConn.Close()
			log.Printf("Project VM %s: waiting for Docker (status: %d)", projectID, resp.StatusCode)
		}
	}
}

// cleanupIdleVMs periodically checks for idle VMs and shuts them down.
func (m *VMManager) cleanupIdleVMs() {
	defer m.wg.Done()

	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-m.stopCh:
			return
		case <-ticker.C:
			m.projectVMMu.Lock()

			for projectID, pvm := range m.projectVMs {
				sessionCount := pvm.SessionCount()

				pvm.sessionsMu.RLock()
				lastUsed := pvm.lastUsedAt
				isWarm := pvm.isWarm
				pvm.sessionsMu.RUnlock()

				// If no sessions and idle timeout exceeded, shutdown VM.
				// Skip warm VMs that have never had sessions.
				if sessionCount == 0 && !isWarm && time.Since(lastUsed) > m.idleTimeout {
					log.Printf("Shutting down idle project VM: %s (idle for %v)", projectID, time.Since(lastUsed))

					if err := pvm.Shutdown(); err != nil {
						log.Printf("Error stopping idle VM %s: %v", projectID, err)
					}

					delete(m.projectVMs, projectID)
				}
			}

			m.projectVMMu.Unlock()
		}
	}
}
