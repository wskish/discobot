package git

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LocalProvider implements Provider using the local git CLI.
// Workspaces are cloned directly to {baseDir}/{projectID}/workspaces/{workspaceID}.
type LocalProvider struct {
	// baseDir is the root directory for all git operations
	baseDir string

	// Per-project mutexes for EnsureWorkspace operations
	projectMu    sync.Mutex
	projectLocks map[string]*sync.Mutex

	// workspaceIndex maps workspace IDs to their repo info
	mu             sync.RWMutex
	workspaceIndex map[string]*workspaceInfo
}

// workspaceInfo tracks information about a workspace's git setup
type workspaceInfo struct {
	projectID string // Project this workspace belongs to
	workDir   string // Path to the working copy
	source    string // Original source (URL or path)
	isRemote  bool   // True if source was a remote URL
}

// NewLocalProvider creates a new local git provider.
// baseDir is the root directory where workspaces will be stored.
// Structure: {baseDir}/{projectID}/workspaces/{workspaceID}/
func NewLocalProvider(baseDir string) (*LocalProvider, error) {
	// Ensure base directory exists
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create base directory: %w", err)
	}

	return &LocalProvider{
		baseDir:        baseDir,
		projectLocks:   make(map[string]*sync.Mutex),
		workspaceIndex: make(map[string]*workspaceInfo),
	}, nil
}

// getProjectLock returns a mutex for the given project, creating one if needed.
func (p *LocalProvider) getProjectLock(projectID string) *sync.Mutex {
	p.projectMu.Lock()
	defer p.projectMu.Unlock()

	if lock, ok := p.projectLocks[projectID]; ok {
		return lock
	}
	lock := &sync.Mutex{}
	p.projectLocks[projectID] = lock
	return lock
}

// EnsureWorkspace ensures a workspace has a working copy ready.
// The projectID parameter scopes all directories to the project.
// Returns the working directory path and the current HEAD commit SHA.
// Locking is done at the project level to allow concurrent operations on different projects.
// Note: workspaceID must be globally unique (e.g., UUID) as it's used as the index key.
func (p *LocalProvider) EnsureWorkspace(ctx context.Context, projectID, workspaceID, source, ref string) (string, string, error) {
	// Fast path: check if workspace already exists in index
	p.mu.RLock()
	if info, ok := p.workspaceIndex[workspaceID]; ok {
		p.mu.RUnlock()
		commit, err := p.runGitOutput(ctx, info.workDir, "rev-parse", "HEAD")
		if err != nil {
			return info.workDir, "", nil // Return workDir even if we can't get commit
		}
		return info.workDir, strings.TrimSpace(commit), nil
	}
	p.mu.RUnlock()

	// Acquire project-level lock for the slow path
	projectLock := p.getProjectLock(projectID)
	projectLock.Lock()
	defer projectLock.Unlock()

	// Double-check: workspace might have been created while waiting for lock
	p.mu.RLock()
	if info, ok := p.workspaceIndex[workspaceID]; ok {
		p.mu.RUnlock()
		commit, err := p.runGitOutput(ctx, info.workDir, "rev-parse", "HEAD")
		if err != nil {
			return info.workDir, "", nil
		}
		return info.workDir, strings.TrimSpace(commit), nil
	}
	p.mu.RUnlock()

	// Create project-scoped workspaces directory
	projectWorkspacesDir := filepath.Join(p.baseDir, projectID, "workspaces")
	if err := os.MkdirAll(projectWorkspacesDir, 0755); err != nil {
		return "", "", fmt.Errorf("failed to create project workspaces directory: %w", err)
	}

	workDir := filepath.Join(projectWorkspacesDir, workspaceID)

	// Check if working directory already exists on disk
	if _, err := os.Stat(filepath.Join(workDir, ".git")); err == nil {
		info := &workspaceInfo{
			projectID: projectID,
			workDir:   workDir,
			source:    source,
			isRemote:  IsGitURL(source),
		}
		p.mu.Lock()
		p.workspaceIndex[workspaceID] = info
		p.mu.Unlock()
		commit, _ := p.runGitOutput(ctx, workDir, "rev-parse", "HEAD")
		return workDir, strings.TrimSpace(commit), nil
	}

	var info *workspaceInfo

	if IsGitURL(source) {
		// Remote repository - clone directly
		args := []string{"clone"}
		if ref != "" {
			args = append(args, "-b", ref)
		}
		args = append(args, source, workDir)

		if err := p.runGit(ctx, "", args...); err != nil {
			return "", "", fmt.Errorf("%w: %v", ErrCloneFailed, err)
		}

		info = &workspaceInfo{
			projectID: projectID,
			workDir:   workDir,
			source:    source,
			isRemote:  true,
		}
	} else {
		// Local path - validate and clone
		absSource, err := filepath.Abs(source)
		if err != nil {
			return "", "", fmt.Errorf("invalid path: %w", err)
		}

		// Check if it's a git repo
		if _, err := os.Stat(filepath.Join(absSource, ".git")); err != nil {
			return "", "", fmt.Errorf("%w: %s", ErrNotARepository, absSource)
		}

		// Clone to get an isolated working copy
		if err := p.runGit(ctx, "", "clone", absSource, workDir); err != nil {
			return "", "", fmt.Errorf("%w: %v", ErrCloneFailed, err)
		}

		// Checkout specific ref if provided
		if ref != "" {
			if err := p.runGit(ctx, workDir, "checkout", ref); err != nil {
				return "", "", fmt.Errorf("%w: %v", ErrCheckoutFailed, err)
			}
		}

		info = &workspaceInfo{
			projectID: projectID,
			workDir:   workDir,
			source:    absSource,
			isRemote:  false,
		}
	}

	p.mu.Lock()
	p.workspaceIndex[workspaceID] = info
	p.mu.Unlock()
	commit, _ := p.runGitOutput(ctx, workDir, "rev-parse", "HEAD")
	return workDir, strings.TrimSpace(commit), nil
}

// Fetch fetches updates from remote.
func (p *LocalProvider) Fetch(ctx context.Context, workspaceID string) error {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	if err := p.runGit(ctx, workDir, "fetch", "--all", "--prune"); err != nil {
		return fmt.Errorf("%w: %v", ErrFetchFailed, err)
	}

	return nil
}

// Checkout checks out a specific ref.
func (p *LocalProvider) Checkout(ctx context.Context, workspaceID, ref string) error {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	if err := p.runGit(ctx, workDir, "checkout", ref); err != nil {
		return fmt.Errorf("%w: %v", ErrCheckoutFailed, err)
	}

	return nil
}

// Status returns the current git status.
func (p *LocalProvider) Status(ctx context.Context, workspaceID string) (*Status, error) {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return nil, fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	status := &Status{
		Staged:    []FileStatus{},
		Unstaged:  []FileStatus{},
		Untracked: []string{},
	}

	// Get current branch
	branch, err := p.runGitOutput(ctx, workDir, "rev-parse", "--abbrev-ref", "HEAD")
	if err == nil {
		status.Branch = strings.TrimSpace(branch)
	}

	// Get current commit
	commit, err := p.runGitOutput(ctx, workDir, "rev-parse", "HEAD")
	if err == nil {
		status.Commit = strings.TrimSpace(commit)
		if len(status.Commit) >= 7 {
			status.CommitShort = status.Commit[:7]
		}
	}

	// Get ahead/behind
	revList, err := p.runGitOutput(ctx, workDir, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
	if err == nil {
		parts := strings.Fields(strings.TrimSpace(revList))
		if len(parts) == 2 {
			status.Ahead, _ = strconv.Atoi(parts[0])
			status.Behind, _ = strconv.Atoi(parts[1])
		}
	}

	// Get porcelain status
	porcelain, err := p.runGitOutput(ctx, workDir, "status", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}

	status.IsClean = true
	entries := strings.Split(porcelain, "\x00")
	for _, entry := range entries {
		if len(entry) < 3 {
			continue
		}

		status.IsClean = false
		index := entry[0]
		worktree := entry[1]
		path := entry[3:]

		// Check for conflicts
		if index == 'U' || worktree == 'U' || (index == 'A' && worktree == 'A') || (index == 'D' && worktree == 'D') {
			status.HasConflicts = true
		}

		// Staged changes
		if index != ' ' && index != '?' {
			status.Staged = append(status.Staged, FileStatus{
				Path:   path,
				Status: p.statusCodeToString(index),
			})
		}

		// Unstaged changes
		if worktree != ' ' && worktree != '?' {
			status.Unstaged = append(status.Unstaged, FileStatus{
				Path:   path,
				Status: p.statusCodeToString(worktree),
			})
		}

		// Untracked files
		if index == '?' && worktree == '?' {
			status.Untracked = append(status.Untracked, path)
		}
	}

	return status, nil
}

// Diff returns file diffs.
func (p *LocalProvider) Diff(ctx context.Context, workspaceID string, opts DiffOptions) ([]FileDiff, error) {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return nil, fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	args := []string{"diff", "--no-color"}

	if opts.Context > 0 {
		args = append(args, fmt.Sprintf("-U%d", opts.Context))
	}

	if opts.Staged {
		args = append(args, "--cached")
	}

	if opts.BaseRef != "" {
		if opts.HeadRef != "" {
			args = append(args, opts.BaseRef+".."+opts.HeadRef)
		} else {
			args = append(args, opts.BaseRef)
		}
	}

	if len(opts.Paths) > 0 {
		args = append(args, "--")
		args = append(args, opts.Paths...)
	}

	output, err := p.runGitOutput(ctx, workDir, args...)
	if err != nil {
		return nil, err
	}

	return p.parseDiff(output), nil
}

// Branches lists all branches.
func (p *LocalProvider) Branches(ctx context.Context, workspaceID string) ([]Branch, error) {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return nil, fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	output, err := p.runGitOutput(ctx, workDir, "branch", "-a", "--format=%(refname:short)|%(objectname:short)|%(upstream:short)|%(HEAD)")
	if err != nil {
		return nil, err
	}

	var branches []Branch
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Split(line, "|")
		if len(parts) < 4 {
			continue
		}

		name := strings.TrimSpace(parts[0])
		branch := Branch{
			Name:      name,
			IsRemote:  strings.HasPrefix(name, "origin/") || strings.Contains(name, "/"),
			Commit:    strings.TrimSpace(parts[1]),
			Upstream:  strings.TrimSpace(parts[2]),
			IsCurrent: strings.TrimSpace(parts[3]) == "*",
		}

		// Skip HEAD reference
		if name == "origin/HEAD" || strings.HasSuffix(name, "/HEAD") {
			continue
		}

		branches = append(branches, branch)
	}

	return branches, nil
}

// FileTree returns the file listing at a specific ref.
func (p *LocalProvider) FileTree(ctx context.Context, workspaceID, ref string) ([]FileEntry, error) {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return nil, fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	if ref == "" {
		ref = "HEAD"
	}

	output, err := p.runGitOutput(ctx, workDir, "ls-tree", "-r", "-l", ref)
	if err != nil {
		return nil, err
	}

	var entries []FileEntry
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		// Format: mode type sha size\tpath
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}

		meta := strings.Fields(parts[0])
		if len(meta) < 4 {
			continue
		}

		path := parts[1]
		size, _ := strconv.ParseInt(meta[3], 10, 64)
		if meta[3] == "-" {
			size = 0 // Directories have "-" as size
		}

		entries = append(entries, FileEntry{
			Path:  path,
			Name:  filepath.Base(path),
			IsDir: meta[1] == "tree",
			Size:  size,
			Mode:  meta[0],
		})
	}

	return entries, nil
}

// ReadFile reads a file at a specific ref.
func (p *LocalProvider) ReadFile(ctx context.Context, workspaceID, ref, path string) ([]byte, error) {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return nil, fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	if ref == "" {
		// Read from working tree
		fullPath := filepath.Join(workDir, path)
		return os.ReadFile(fullPath)
	}

	// Read from specific ref
	output, err := p.runGitOutput(ctx, workDir, "show", ref+":"+path)
	if err != nil {
		return nil, fmt.Errorf("%w: %s at %s", ErrNotFound, path, ref)
	}

	return []byte(output), nil
}

// WriteFile writes content to a file in the working tree.
func (p *LocalProvider) WriteFile(ctx context.Context, workspaceID, path string, content []byte) error {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	fullPath := filepath.Join(workDir, path)

	// Ensure directory exists
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return err
	}

	return os.WriteFile(fullPath, content, 0644)
}

// Stage stages files for commit.
func (p *LocalProvider) Stage(ctx context.Context, workspaceID string, paths []string) error {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	args := append([]string{"add"}, paths...)
	return p.runGit(ctx, workDir, args...)
}

// Commit creates a commit with the staged changes.
func (p *LocalProvider) Commit(ctx context.Context, workspaceID, message, authorName, authorEmail string) (*Commit, error) {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return nil, fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	args := []string{"commit", "-m", message}
	if authorName != "" && authorEmail != "" {
		args = append(args, "--author", fmt.Sprintf("%s <%s>", authorName, authorEmail))
	}

	if err := p.runGit(ctx, workDir, args...); err != nil {
		return nil, err
	}

	// Get the commit info
	return p.getCommit(ctx, workDir, "HEAD")
}

// Log returns commit history.
func (p *LocalProvider) Log(ctx context.Context, workspaceID string, opts LogOptions) ([]Commit, error) {
	workDir := p.GetWorkDir(ctx, workspaceID)
	if workDir == "" {
		return nil, fmt.Errorf("%w: workspace %s", ErrNotFound, workspaceID)
	}

	limit := opts.Limit
	if limit <= 0 {
		limit = 50
	}

	ref := opts.Ref
	if ref == "" {
		ref = "HEAD"
	}

	args := []string{"log", ref, fmt.Sprintf("-n%d", limit), "--format=%H|%h|%s|%an|%ae|%aI|%cn|%cI|%P"}

	if opts.Skip > 0 {
		args = append(args, fmt.Sprintf("--skip=%d", opts.Skip))
	}

	if len(opts.Paths) > 0 {
		args = append(args, "--")
		args = append(args, opts.Paths...)
	}

	output, err := p.runGitOutput(ctx, workDir, args...)
	if err != nil {
		return nil, err
	}

	var commits []Commit
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Split(line, "|")
		if len(parts) < 9 {
			continue
		}

		authorDate, _ := time.Parse(time.RFC3339, parts[5])
		commitDate, _ := time.Parse(time.RFC3339, parts[7])

		var parents []string
		if parts[8] != "" {
			parents = strings.Fields(parts[8])
		}

		commits = append(commits, Commit{
			SHA:         parts[0],
			ShortSHA:    parts[1],
			Message:     parts[2],
			Author:      parts[3],
			AuthorEmail: parts[4],
			AuthorDate:  authorDate,
			Committer:   parts[6],
			CommitDate:  commitDate,
			Parents:     parents,
		})
	}

	return commits, nil
}

// GetWorkDir returns the working directory path for a workspace.
// Note: This only returns workspaces that are in the index. Use EnsureWorkspace
// to initialize a workspace if it might exist on disk but not in the index.
func (p *LocalProvider) GetWorkDir(ctx context.Context, workspaceID string) string {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if info, ok := p.workspaceIndex[workspaceID]; ok {
		return info.workDir
	}

	return ""
}

// RemoveWorkspace removes the workspace working directory.
func (p *LocalProvider) RemoveWorkspace(ctx context.Context, workspaceID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	info, ok := p.workspaceIndex[workspaceID]
	if !ok {
		return nil // Not in index, nothing to remove
	}

	delete(p.workspaceIndex, workspaceID)
	return os.RemoveAll(info.workDir)
}

// --- Internal helpers ---

// runGit runs a git command.
func (p *LocalProvider) runGit(ctx context.Context, workDir string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	if workDir != "" {
		cmd.Dir = workDir
	}

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, stderr.String())
	}

	return nil
}

// runGitOutput runs a git command and returns stdout.
func (p *LocalProvider) runGitOutput(ctx context.Context, workDir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	if workDir != "" {
		cmd.Dir = workDir
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, stderr.String())
	}

	return stdout.String(), nil
}

// statusCodeToString converts a git status code to a human-readable string.
func (p *LocalProvider) statusCodeToString(code byte) string {
	switch code {
	case 'A':
		return "added"
	case 'M':
		return "modified"
	case 'D':
		return "deleted"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	case 'U':
		return "unmerged"
	case 'T':
		return "typechanged"
	default:
		return "unknown"
	}
}

// parseDiff parses unified diff output into FileDiff structs.
func (p *LocalProvider) parseDiff(output string) []FileDiff {
	var diffs []FileDiff
	var current *FileDiff
	var patchLines []string

	// Regex to match diff header
	diffHeader := regexp.MustCompile(`^diff --git a/(.+) b/(.+)$`)
	additions := 0
	deletions := 0

	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()

		if matches := diffHeader.FindStringSubmatch(line); matches != nil {
			// Save previous diff
			if current != nil {
				current.Patch = strings.Join(patchLines, "\n")
				current.Additions = additions
				current.Deletions = deletions
				diffs = append(diffs, *current)
			}

			// Start new diff
			current = &FileDiff{
				OldPath: matches[1],
				Path:    matches[2],
				Status:  "modified",
			}
			patchLines = []string{line}
			additions = 0
			deletions = 0
			continue
		}

		if current != nil {
			patchLines = append(patchLines, line)

			// Detect file status
			if strings.HasPrefix(line, "new file mode") {
				current.Status = "added"
			} else if strings.HasPrefix(line, "deleted file mode") {
				current.Status = "deleted"
			} else if strings.HasPrefix(line, "rename from") {
				current.Status = "renamed"
			} else if strings.HasPrefix(line, "Binary files") {
				current.Binary = true
			} else if strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++") {
				additions++
			} else if strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---") {
				deletions++
			}
		}
	}

	// Don't forget the last diff
	if current != nil {
		current.Patch = strings.Join(patchLines, "\n")
		current.Additions = additions
		current.Deletions = deletions
		diffs = append(diffs, *current)
	}

	return diffs
}

// getCommit gets commit info for a ref.
func (p *LocalProvider) getCommit(ctx context.Context, workDir, ref string) (*Commit, error) {
	output, err := p.runGitOutput(ctx, workDir, "log", ref, "-1", "--format=%H|%h|%s|%an|%ae|%aI|%cn|%cI|%P")
	if err != nil {
		return nil, err
	}

	line := strings.TrimSpace(output)
	parts := strings.Split(line, "|")
	if len(parts) < 9 {
		return nil, fmt.Errorf("unexpected log format")
	}

	authorDate, _ := time.Parse(time.RFC3339, parts[5])
	commitDate, _ := time.Parse(time.RFC3339, parts[7])

	var parents []string
	if parts[8] != "" {
		parents = strings.Fields(parts[8])
	}

	return &Commit{
		SHA:         parts[0],
		ShortSHA:    parts[1],
		Message:     parts[2],
		Author:      parts[3],
		AuthorEmail: parts[4],
		AuthorDate:  authorDate,
		Committer:   parts[6],
		CommitDate:  commitDate,
		Parents:     parents,
	}, nil
}

// Ensure LocalProvider implements Provider
var _ Provider = (*LocalProvider)(nil)
