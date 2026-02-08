package vz

// StatusDetails contains VZ-specific status details returned in ProviderStatus.Details.
type StatusDetails struct {
	Progress *DownloadProgress   `json:"progress,omitempty"`
	Config   *ProviderConfigInfo `json:"config,omitempty"`
}

// ProviderConfigInfo contains VZ provider configuration information.
type ProviderConfigInfo struct {
	KernelPath   string `json:"kernel_path,omitempty"`
	BaseDiskPath string `json:"base_disk_path,omitempty"`
	DataDir      string `json:"data_dir,omitempty"`
	MemoryMB     int    `json:"memory_mb"`
	CPUCount     int    `json:"cpu_count"`
	DataDiskGB   int    `json:"data_disk_gb"`
}
