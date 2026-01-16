//go:build darwin

package vz

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/obot-platform/octobot/server/internal/sandbox"
)

const (
	// metadataSubdir is the subdirectory within dataDir for VM metadata.
	metadataSubdir = "metadata"

	// MetadataTag is the VirtioFS tag used to mount metadata in the guest.
	// The guest should mount this at /run/octobot/metadata.
	MetadataTag = "octobot-meta"

	// MetadataGuestPath is the recommended mount point in the guest.
	MetadataGuestPath = "/run/octobot/metadata"
)

// VMMetadata contains configuration passed to the VM via VirtioFS.
// This is written to the metadata directory before VM start and
// mounted read-only in the guest.
type VMMetadata struct {
	// SessionID is the octobot session identifier.
	SessionID string `json:"session_id"`

	// Secret is the hashed shared secret for authentication.
	// Format: "salt:hash" (hex-encoded).
	Secret string `json:"secret,omitempty"`

	// Env contains environment variables for the agent.
	Env map[string]string `json:"env,omitempty"`

	// Workspace contains workspace configuration.
	Workspace *WorkspaceMetadata `json:"workspace,omitempty"`

	// Agent contains agent-specific configuration.
	Agent *AgentMetadata `json:"agent,omitempty"`
}

// WorkspaceMetadata contains workspace configuration.
type WorkspaceMetadata struct {
	// Path is either a local path (mounted) or git URL.
	Path string `json:"path,omitempty"`

	// Commit is the git commit to checkout (for git URLs).
	Commit string `json:"commit,omitempty"`

	// MountPoint is where the workspace is mounted in the guest.
	// For local paths, this is typically /.workspace.origin
	MountPoint string `json:"mount_point,omitempty"`
}

// AgentMetadata contains agent-specific configuration.
type AgentMetadata struct {
	// Command is the agent command to run (e.g., "claude-code-acp").
	Command string `json:"command,omitempty"`

	// Args are additional arguments for the agent command.
	Args []string `json:"args,omitempty"`

	// WorkDir is the working directory for the agent.
	WorkDir string `json:"workdir,omitempty"`

	// Port is the TCP port the agent HTTP server listens on.
	Port int `json:"port,omitempty"`

	// Vsock configures vsock-to-TCP forwarding.
	// If set, the agent should start socat to forward from vsock to TCP.
	Vsock *VsockConfig `json:"vsock,omitempty"`
}

// VsockConfig configures vsock forwarding.
type VsockConfig struct {
	// Port is the vsock port to listen on (host connects to this).
	Port int `json:"port"`

	// TargetPort is the TCP port to forward to (where HTTP server listens).
	// If not set, defaults to AgentMetadata.Port.
	TargetPort int `json:"target_port,omitempty"`
}

// metadataDir returns the path to the metadata directory for a session.
func (p *Provider) metadataDir(sessionID string) string {
	return filepath.Join(p.dataDir, metadataSubdir, sessionID)
}

// createMetadata creates the metadata directory and writes configuration files.
func (p *Provider) createMetadata(sessionID string, opts sandbox.CreateOptions) error {
	metaDir := p.metadataDir(sessionID)

	// Create metadata directory
	if err := os.MkdirAll(metaDir, 0755); err != nil {
		return fmt.Errorf("failed to create metadata directory: %w", err)
	}

	// Build metadata
	// Agent listens on TCP port 3002, socat forwards vsock:3002 → TCP:3002
	const agentTCPPort = 3002
	meta := VMMetadata{
		SessionID: sessionID,
		Env:       make(map[string]string),
		Agent: &AgentMetadata{
			Port: agentTCPPort,
			Vsock: &VsockConfig{
				Port:       VsockPort,    // vsock port host connects to (3002)
				TargetPort: agentTCPPort, // TCP port agent listens on (3002)
			},
		},
	}

	// Add hashed secret
	if opts.SharedSecret != "" {
		meta.Secret = hashSecret(opts.SharedSecret)
	}

	// Add workspace configuration
	if opts.WorkspacePath != "" {
		meta.Workspace = &WorkspaceMetadata{
			Path:   opts.WorkspacePath,
			Commit: opts.WorkspaceCommit,
		}
		if !isGitURL(opts.WorkspacePath) {
			meta.Workspace.MountPoint = workspaceOriginPath
		}
	}

	// Copy labels to env
	for k, v := range opts.Labels {
		meta.Env[k] = v
	}

	// Write metadata.json
	metaPath := filepath.Join(metaDir, "metadata.json")
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal metadata: %w", err)
	}

	if err := os.WriteFile(metaPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write metadata: %w", err)
	}

	// Write individual files for easy shell access
	if err := os.WriteFile(filepath.Join(metaDir, "session_id"), []byte(sessionID), 0644); err != nil {
		return fmt.Errorf("failed to write session_id: %w", err)
	}

	if meta.Secret != "" {
		if err := os.WriteFile(filepath.Join(metaDir, "secret"), []byte(meta.Secret), 0600); err != nil {
			return fmt.Errorf("failed to write secret: %w", err)
		}
	}

	return nil
}

// updateMetadata updates the metadata files for a session.
func (p *Provider) updateMetadata(sessionID string, meta *VMMetadata) error {
	metaDir := p.metadataDir(sessionID)

	// Write metadata.json
	metaPath := filepath.Join(metaDir, "metadata.json")
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal metadata: %w", err)
	}

	if err := os.WriteFile(metaPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write metadata: %w", err)
	}

	return nil
}

// deleteMetadata removes the metadata directory for a session.
func (p *Provider) deleteMetadata(sessionID string) error {
	metaDir := p.metadataDir(sessionID)
	if err := os.RemoveAll(metaDir); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete metadata directory: %w", err)
	}
	return nil
}

// readMetadata reads the metadata for a session.
func (p *Provider) readMetadata(sessionID string) (*VMMetadata, error) {
	metaPath := filepath.Join(p.metadataDir(sessionID), "metadata.json")

	data, err := os.ReadFile(metaPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read metadata: %w", err)
	}

	var meta VMMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("failed to unmarshal metadata: %w", err)
	}

	return &meta, nil
}
