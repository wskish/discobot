package logfile

import (
	"fmt"
	"io"
	"os"
)

const (
	maxSize  = 500 * 1024 // 500 KB
	keepSize = 10 * 1024  // 10 KB
)

// Truncate truncates the log file if it exceeds maxSize, keeping the last
// keepSize bytes. This prevents unbounded log growth across server restarts.
func Truncate(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return nil // file doesn't exist, nothing to do
	}
	if info.Size() <= maxSize {
		return nil
	}

	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open log file for truncation: %w", err)
	}

	seekPos := info.Size() - keepSize
	if seekPos < 0 {
		seekPos = 0
	}
	if _, err := f.Seek(seekPos, io.SeekStart); err != nil {
		f.Close()
		return fmt.Errorf("seek in log file: %w", err)
	}

	tail, err := io.ReadAll(f)
	f.Close()
	if err != nil {
		return fmt.Errorf("read log file tail: %w", err)
	}

	// Rewrite the file with a truncation notice and the tail
	out, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("recreate log file: %w", err)
	}
	defer out.Close()

	header := fmt.Sprintf("=== Log truncated (was %d bytes, keeping last %d bytes) ===\n", info.Size(), len(tail))
	if _, err := out.WriteString(header); err != nil {
		return fmt.Errorf("write truncation header: %w", err)
	}
	if _, err := out.Write(tail); err != nil {
		return fmt.Errorf("write log tail: %w", err)
	}

	return nil
}
