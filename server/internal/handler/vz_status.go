package handler

import (
	"net/http"
	"runtime"

	"github.com/obot-platform/discobot/server/internal/sandbox/vz"
)

// GetVZStatus returns the status of the VZ provider.
// GET /api/projects/{projectId}/vz/status
func (h *Handler) GetVZStatus(w http.ResponseWriter, _ *http.Request) {
	// VZ is only available on darwin/arm64
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		h.JSON(w, http.StatusOK, vz.ProviderStatus{
			Available: false,
			State:     "not_available",
			Message:   "VZ provider is only available on macOS ARM64",
		})
		return
	}

	// Get VZ provider from sandbox manager
	vzProvider, err := h.sandboxManager.GetProvider("vz")
	if err != nil {
		h.JSON(w, http.StatusOK, vz.ProviderStatus{
			Available: false,
			State:     "not_available",
			Message:   "VZ provider not registered",
		})
		return
	}

	// Cast to VZ provider to access Status method
	vzDockerProvider, ok := vzProvider.(*vz.DockerProvider)
	if !ok {
		h.JSON(w, http.StatusOK, vz.ProviderStatus{
			Available: false,
			State:     "not_available",
			Message:   "VZ provider has unexpected type",
		})
		return
	}

	// Get and return status
	status := vzDockerProvider.Status()
	h.JSON(w, http.StatusOK, status)
}
