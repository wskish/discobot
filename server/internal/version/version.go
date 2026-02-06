package version

// Version is the version of the server binary.
// It is set at build time via -ldflags.
// Default value is "main" for development builds.
var Version = "main"

// Get returns the current version string
func Get() string {
	return Version
}
