package vz

// ProviderStatus represents the current status of the VZ provider.
// This type is platform-independent.
type ProviderStatus struct {
	Available bool                `json:"available"`
	State     string              `json:"state"` // "not_available", "downloading", "ready", "failed"
	Message   string              `json:"message,omitempty"`
	Progress  *DownloadProgress   `json:"progress,omitempty"`
	Config    *ProviderConfigInfo `json:"config,omitempty"`
}

// ProviderConfigInfo contains VZ provider configuration information.
type ProviderConfigInfo struct {
	KernelPath   string `json:"kernel_path,omitempty"`
	BaseDiskPath string `json:"base_disk_path,omitempty"`
	DataDir      string `json:"data_dir,omitempty"`
	MemoryMB     int    `json:"memory_mb"`
	CPUCount     int    `json:"cpu_count"`
}
