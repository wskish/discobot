// Package docker provides cache volume management for Docker containers.
package docker

import (
	"context"
	"fmt"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/docker/docker/api/types/filters"
	volumeTypes "github.com/docker/docker/api/types/volume"
)

const (
	// cacheVolumePrefix is the prefix for project-scoped cache volume names.
	cacheVolumePrefix = "discobot-cache-"
)

// cacheVolumeName generates a cache volume name from project ID.
func cacheVolumeName(projectID string) string {
	return fmt.Sprintf("%s%s", cacheVolumePrefix, projectID)
}

// ensureCacheVolume creates the project-scoped cache volume if it doesn't exist and returns its name.
func (p *Provider) ensureCacheVolume(ctx context.Context, projectID string) (string, error) {
	volName := cacheVolumeName(projectID)

	// Try to inspect the volume first
	_, err := p.client.VolumeInspect(ctx, volName)
	if err == nil {
		// Volume already exists
		return volName, nil
	}

	// Create the volume
	_, err = p.client.VolumeCreate(ctx, volumeTypes.CreateOptions{
		Name: volName,
		Labels: map[string]string{
			"discobot.project.id": projectID,
			"discobot.managed":    "true",
			"discobot.type":       "cache",
		},
	})
	if err != nil {
		return "", fmt.Errorf("failed to create cache volume: %w", err)
	}

	return volName, nil
}

// RemoveCacheVolume removes the project-scoped cache volume.
// This should be called when a project is deleted.
// This is exported to satisfy the cacheVolumeManager interface check in ProjectService.
func (p *Provider) RemoveCacheVolume(ctx context.Context, projectID string) error {
	volName := cacheVolumeName(projectID)

	// Force removal even if volume is in use
	if err := p.client.VolumeRemove(ctx, volName, true); err != nil {
		// Ignore "not found" errors
		if !cerrdefs.IsNotFound(err) {
			return fmt.Errorf("failed to remove cache volume: %w", err)
		}
	}

	return nil
}

// ListCacheVolumes returns all cache volumes, optionally filtered by project ID.
func (p *Provider) ListCacheVolumes(ctx context.Context, projectID string) ([]*volumeTypes.Volume, error) {
	filters := filters.NewArgs()
	filters.Add("label", "discobot.managed=true")
	filters.Add("label", "discobot.type=cache")

	if projectID != "" {
		filters.Add("label", fmt.Sprintf("discobot.project.id=%s", projectID))
	}

	resp, err := p.client.VolumeList(ctx, volumeTypes.ListOptions{
		Filters: filters,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list cache volumes: %w", err)
	}

	return resp.Volumes, nil
}
