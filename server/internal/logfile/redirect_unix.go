//go:build !windows

package logfile

import (
	"fmt"
	"os"
	"syscall"
)

// RedirectStdoutStderr redirects both stdout and stderr to the given file path.
// This operates at the file descriptor level so it captures all output,
// including from C libraries and subprocesses.
func RedirectStdoutStderr(path string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}

	fd := int(f.Fd())
	if err := syscall.Dup2(fd, int(os.Stdout.Fd())); err != nil {
		return fmt.Errorf("dup2 stdout: %w", err)
	}
	if err := syscall.Dup2(fd, int(os.Stderr.Fd())); err != nil {
		return fmt.Errorf("dup2 stderr: %w", err)
	}

	return nil
}
