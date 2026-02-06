package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
)

// runProxy implements the VSOCK port proxy for VZ VMs.
// It watches Docker events for containers with published ports and creates
// socat VSOCK listeners that forward those ports to the host.
func runProxy() error {
	fmt.Println("discobot-agent-proxy: starting VSOCK port proxy")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Connect to Docker
	cli, err := client.NewClientWithOpts(
		client.WithHost("unix:///var/run/docker.sock"),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return fmt.Errorf("failed to create docker client: %w", err)
	}
	defer cli.Close()

	// Wait for Docker to be ready
	if err := waitForDockerReady(ctx, cli); err != nil {
		return fmt.Errorf("docker not ready: %w", err)
	}

	fmt.Println("discobot-agent-proxy: connected to Docker")

	// Track socat processes: containerID -> []*exec.Cmd
	mu := &sync.Mutex{}
	socatProcs := make(map[string][]*exec.Cmd)

	// Handle existing containers
	containers, err := cli.ContainerList(ctx, container.ListOptions{
		Filters: filters.NewArgs(
			filters.Arg("label", "discobot.managed=true"),
			filters.Arg("status", "running"),
		),
	})
	if err != nil {
		return fmt.Errorf("failed to list containers: %w", err)
	}

	for _, c := range containers {
		ports := extractPublishedPorts(c.Ports)
		if len(ports) > 0 {
			startSocatForContainer(mu, socatProcs, c.ID, ports)
		}
	}

	// Handle shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		<-sigCh
		fmt.Println("discobot-agent-proxy: shutting down")
		cancel()
	}()

	// Watch Docker events with auto-reconnect
	watchDockerEventsProxy(ctx, cli, mu, socatProcs)

	// Cleanup all socat processes
	mu.Lock()
	for containerID, cmds := range socatProcs {
		for _, cmd := range cmds {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		}
		delete(socatProcs, containerID)
	}
	mu.Unlock()

	fmt.Println("discobot-agent-proxy: stopped")
	return nil
}

// waitForDockerReady polls Docker until it responds to ping.
func waitForDockerReady(ctx context.Context, cli *client.Client) error {
	deadline := time.Now().Add(60 * time.Second)
	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("timeout waiting for docker")
		}
		_, err := cli.Ping(ctx)
		if err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(1 * time.Second):
		}
	}
}

// extractPublishedPorts returns the host ports from a container's port list.
func extractPublishedPorts(ports []container.Port) []int {
	seen := make(map[int]bool)
	var result []int
	for _, p := range ports {
		if p.PublicPort > 0 && !seen[int(p.PublicPort)] {
			seen[int(p.PublicPort)] = true
			result = append(result, int(p.PublicPort))
		}
	}
	return result
}

// extractPublishedPortsFromInspect extracts published host ports from a container inspect result.
func extractPublishedPortsFromInspect(info container.InspectResponse) []int {
	seen := make(map[int]bool)
	var result []int
	for _, bindings := range info.NetworkSettings.Ports {
		for _, b := range bindings {
			port, err := strconv.Atoi(b.HostPort)
			if err == nil && port > 0 && !seen[port] {
				seen[port] = true
				result = append(result, port)
			}
		}
	}
	return result
}

// startSocatForContainer starts socat VSOCK listeners for the given ports.
func startSocatForContainer(mu *sync.Mutex, socatProcs map[string][]*exec.Cmd, containerID string, ports []int) {
	mu.Lock()
	defer mu.Unlock()

	// Kill any existing socat processes for this container
	if cmds, exists := socatProcs[containerID]; exists {
		for _, cmd := range cmds {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		}
	}

	var cmds []*exec.Cmd
	for _, port := range ports {
		cmd := exec.Command("socat",
			"-b131072",
			fmt.Sprintf("VSOCK-LISTEN:%d,reuseaddr,fork", port),
			fmt.Sprintf("TCP:localhost:%d", port),
		)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		if err := cmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "discobot-agent-proxy: failed to start socat for port %d: %v\n", port, err)
			continue
		}

		fmt.Printf("discobot-agent-proxy: forwarding VSOCK port %d -> localhost:%d (container %s)\n", port, port, containerID[:12])
		cmds = append(cmds, cmd)

		// Reap socat process when it exits
		go func(c *exec.Cmd, p int) {
			_ = c.Wait()
		}(cmd, port)
	}

	socatProcs[containerID] = cmds
}

// stopSocatForContainer kills all socat processes for a container.
func stopSocatForContainer(mu *sync.Mutex, socatProcs map[string][]*exec.Cmd, containerID string) {
	mu.Lock()
	defer mu.Unlock()

	cmds, exists := socatProcs[containerID]
	if !exists {
		return
	}

	for _, cmd := range cmds {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}
	delete(socatProcs, containerID)
	fmt.Printf("discobot-agent-proxy: stopped forwarding for container %s\n", containerID[:12])
}

// watchDockerEventsProxy watches Docker events and manages socat processes.
// Auto-reconnects on stream errors.
func watchDockerEventsProxy(ctx context.Context, cli *client.Client, mu *sync.Mutex, socatProcs map[string][]*exec.Cmd) {
	filterArgs := filters.NewArgs(
		filters.Arg("type", string(events.ContainerEventType)),
		filters.Arg("event", "start"),
		filters.Arg("event", "die"),
		filters.Arg("event", "stop"),
		filters.Arg("event", "destroy"),
	)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		msgCh, errCh := cli.Events(ctx, events.ListOptions{
			Filters: filterArgs,
		})

		done := processProxyEvents(ctx, cli, mu, socatProcs, msgCh, errCh)
		if !done {
			return
		}

		// Recoverable error — wait before reconnecting
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
			fmt.Println("discobot-agent-proxy: reconnecting to Docker events...")
		}
	}
}

// processProxyEvents processes Docker events from channels.
// Returns true if reconnection should be attempted, false if we should exit.
func processProxyEvents(ctx context.Context, cli *client.Client, mu *sync.Mutex, socatProcs map[string][]*exec.Cmd, msgCh <-chan events.Message, errCh <-chan error) bool {
	for {
		select {
		case <-ctx.Done():
			return false

		case err := <-errCh:
			if err == nil {
				return true
			}
			if ctx.Err() != nil {
				return false
			}
			fmt.Fprintf(os.Stderr, "discobot-agent-proxy: docker events error: %v, reconnecting...\n", err)
			return true

		case msg := <-msgCh:
			containerID := msg.Actor.ID
			if containerID == "" {
				continue
			}

			// Check if this is a managed container
			if msg.Actor.Attributes["discobot.managed"] != "true" {
				continue
			}

			switch msg.Action {
			case "start":
				// Inspect container to get published ports
				info, err := cli.ContainerInspect(ctx, containerID)
				if err != nil {
					fmt.Fprintf(os.Stderr, "discobot-agent-proxy: failed to inspect container %s: %v\n", containerID[:12], err)
					continue
				}

				ports := extractPublishedPortsFromInspect(info)
				if len(ports) > 0 {
					startSocatForContainer(mu, socatProcs, containerID, ports)
				}

			case "die", "stop", "destroy":
				stopSocatForContainer(mu, socatProcs, containerID)
			}
		}
	}
}
