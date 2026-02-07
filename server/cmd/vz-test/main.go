//go:build darwin

package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/obot-platform/discobot/server/internal/sandbox/vm"
	"github.com/obot-platform/discobot/server/internal/sandbox/vz"
)

const (
	defaultSocketPath = "/tmp/vz-docker.sock"
	dockerVsockPort   = 2375
)

func main() {
	// Command line flags
	var (
		dataDir       = flag.String("data-dir", "/tmp/vz-test", "Directory for VM data")
		consoleLogDir = flag.String("console-log-dir", "/tmp/vz-test/logs", "Directory for console logs")
		kernelPath    = flag.String("kernel", "", "Path to Linux kernel (vmlinuz)")
		initrdPath    = flag.String("initrd", "", "Path to initrd (optional)")
		baseDiskPath  = flag.String("base-disk", "", "Path to base disk image with Docker")
		socketPath    = flag.String("socket", defaultSocketPath, "Unix socket path for Docker access")
		projectID     = flag.String("project", "test-project", "Project ID for the VM")
		cpuCount      = flag.Int("cpus", 2, "Number of CPUs")
		memoryMB      = flag.Int("memory", 2048, "Memory in MB")
	)

	flag.Parse()

	// Validate required flags
	if *kernelPath == "" {
		log.Fatal("Error: -kernel flag is required")
	}
	if *baseDiskPath == "" {
		log.Fatal("Error: -base-disk flag is required")
	}

	// Expand paths
	*kernelPath = expandPath(*kernelPath)
	*baseDiskPath = expandPath(*baseDiskPath)
	if *initrdPath != "" {
		*initrdPath = expandPath(*initrdPath)
	}
	*dataDir = expandPath(*dataDir)
	*consoleLogDir = expandPath(*consoleLogDir)

	// Create directories
	if err := os.MkdirAll(*dataDir, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}
	if err := os.MkdirAll(*consoleLogDir, 0755); err != nil {
		log.Fatalf("Failed to create console log directory: %v", err)
	}

	log.Printf("VZ Docker Test CLI")
	log.Printf("==================")
	log.Printf("Kernel:       %s", *kernelPath)
	log.Printf("Base Disk:    %s", *baseDiskPath)
	log.Printf("Data Dir:     %s", *dataDir)
	log.Printf("Console Logs: %s", *consoleLogDir)
	log.Printf("Docker Socket: %s", *socketPath)
	log.Printf("")

	// Create VM configuration
	vmConfig := vm.Config{
		DataDir:       *dataDir,
		ConsoleLogDir: *consoleLogDir,
		KernelPath:    *kernelPath,
		InitrdPath:    *initrdPath,
		BaseDiskPath:  *baseDiskPath,
		IdleTimeout:   "0", // Never timeout for testing
		CPUCount:      *cpuCount,
		MemoryMB:      *memoryMB,
	}

	// Create VM manager
	log.Printf("Creating VM manager...")
	vmManager, err := vz.NewVMManager(vmConfig)
	if err != nil {
		log.Fatalf("Failed to create VM manager: %v", err)
	}
	defer vmManager.Shutdown()

	ctx := context.Background()

	// Create VM
	log.Printf("Creating VM for project: %s", *projectID)
	pvm, err := vmManager.GetOrCreateVM(ctx, *projectID, "test-session")
	if err != nil {
		log.Fatalf("Failed to create VM: %v", err)
	}

	log.Printf("VM created successfully!")
	log.Printf("")

	// Remove existing socket if it exists
	os.Remove(*socketPath)

	// Start Unix socket proxy for Docker access
	log.Printf("Starting Docker socket proxy...")
	log.Printf("Unix socket: %s", *socketPath)

	stopProxy := make(chan struct{})
	proxyStopped := make(chan struct{})

	go func() {
		defer close(proxyStopped)
		if err := startDockerProxy(*socketPath, pvm, stopProxy); err != nil {
			log.Printf("Proxy error: %v", err)
		}
	}()

	// Wait for socket to be ready
	time.Sleep(100 * time.Millisecond)

	log.Printf("")
	log.Printf("✓ VM is ready!")
	log.Printf("")
	log.Printf("You can now use Docker CLI:")
	log.Printf("  export DOCKER_HOST=unix://%s", *socketPath)
	log.Printf("  docker ps")
	log.Printf("  docker run hello-world")
	log.Printf("")
	log.Printf("Console log: %s/project-%s/console.log", *consoleLogDir, *projectID)
	log.Printf("")
	log.Printf("Press Ctrl+C to shutdown...")

	// Wait for interrupt signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh

	log.Printf("")
	log.Printf("Shutting down...")

	// Stop proxy
	close(stopProxy)
	<-proxyStopped

	// Remove socket
	os.Remove(*socketPath)

	log.Printf("Shutdown complete")
}

// startDockerProxy creates a Unix socket and proxies connections to the VM's Docker daemon via VSOCK.
func startDockerProxy(socketPath string, pvm vm.ProjectVM, stopCh <-chan struct{}) error {
	// Create Unix socket listener
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("failed to create Unix socket: %w", err)
	}
	defer listener.Close()
	defer os.Remove(socketPath)

	// Make socket accessible
	if err := os.Chmod(socketPath, 0666); err != nil {
		return fmt.Errorf("failed to chmod socket: %w", err)
	}

	log.Printf("Docker proxy listening on: %s", socketPath)

	// Accept connections
	acceptCh := make(chan net.Conn)
	acceptErrCh := make(chan error)

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				acceptErrCh <- err
				return
			}
			acceptCh <- conn
		}
	}()

	for {
		select {
		case <-stopCh:
			return nil

		case err := <-acceptErrCh:
			return err

		case clientConn := <-acceptCh:
			// Handle connection in goroutine
			go handleProxyConnection(clientConn, pvm)
		}
	}
}

// handleProxyConnection proxies a single connection from Unix socket to VSOCK.
func handleProxyConnection(clientConn net.Conn, pvm vm.ProjectVM) {
	defer clientConn.Close()

	// Get Docker dialer
	dialer := pvm.DockerDialer()

	// Connect to Docker daemon via VSOCK
	vmConn, err := dialer(context.Background(), "vsock", "")
	if err != nil {
		log.Printf("Failed to connect to VM Docker: %v", err)
		return
	}
	defer vmConn.Close()

	// Bidirectional copy
	done := make(chan struct{}, 2)

	go func() {
		_, _ = io.Copy(vmConn, clientConn)
		done <- struct{}{}
	}()

	go func() {
		_, _ = io.Copy(clientConn, vmConn)
		done <- struct{}{}
	}()

	<-done
}

// expandPath expands ~ to home directory.
func expandPath(path string) string {
	if path == "" {
		return path
	}
	if path[:2] == "~/" {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}
