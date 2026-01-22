# Session States Design

This document describes the session lifecycle states and commit states, which are tracked independently.

## Overview

Sessions have two independent state dimensions:

1. **Session Status** (`status`): Tracks the lifecycle of the session (initialization, running, stopped, etc.)
2. **Commit Status** (`commitStatus`): Tracks commit operations (orthogonal to session status)

This separation allows a session to be `ready` and `committing` at the same time, which correctly models that the sandbox continues running while a commit is in progress.

## Session Status (Lifecycle)

### State Diagram

```
                                    ┌──────────────┐
                                    │ initializing │
                                    └──────┬───────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
                    ▼                      ▼                      ▼
            ┌───────────┐          ┌──────────────┐       ┌───────────────────┐
            │  cloning  │          │ pulling_image│       │ creating_sandbox  │
            └─────┬─────┘          └──────┬───────┘       └─────────┬─────────┘
                  │                       │                         │
                  └───────────────────────┼─────────────────────────┘
                                          │
                                          ▼
                                    ┌───────────┐
                           ┌────────│   ready   │────────┐
                           │        └─────┬─────┘        │
                           │              │              │
                           ▼              │              ▼
                     ┌──────────┐         │        ┌──────────┐
                     │ stopped  │◄────────┘        │  error   │
                     └────┬─────┘                  └──────────┘
                          │
                          ▼
                   ┌────────────┐
                   │  removing  │
                   └──────┬─────┘
                          │
                          ▼
                    ┌──────────┐
                    │ removed  │
                    └──────────┘
```

### Status Values

| Status | Description |
|--------|-------------|
| `initializing` | Session just created, starting setup process |
| `reinitializing` | Recreating sandbox after it was deleted |
| `cloning` | Cloning git repository for the workspace |
| `pulling_image` | Pulling the sandbox Docker image |
| `creating_sandbox` | Creating the sandbox container environment |
| `ready` | Session is ready for use. Sandbox is running. |
| `stopped` | Sandbox is stopped. Will restart on demand. |
| `error` | Something failed during setup. Check `errorMessage`. |
| `removing` | Session is being deleted asynchronously |
| `removed` | Session has been deleted. |

---

## Commit Status (Orthogonal)

### State Diagram

```
    ┌─────────┐     commit()     ┌──────────┐  /octobot-commit   ┌────────────┐
    │  none   │ ───────────────► │ pending  │ ──────────────────► │ committing │
    └─────────┘                  └──────────┘                     └──────┬─────┘
         ▲                                                               │
         │                                                     ┌─────────┴─────────┐
         │                                                     │                   │
         │                                             success │           failure │
         │                                                     ▼                   ▼
         │                                             ┌────────────┐       ┌──────────┐
         └─────────────────────────────────────────────│ completed  │       │  failed  │
              (can commit again after completed/failed)└────────────┘       └──────────┘
```

### Status Values

| Status | Description |
|--------|-------------|
| `""` (empty) | No commit in progress (default state) |
| `pending` | Commit requested, job enqueued, waiting to send to agent |
| `committing` | `/octobot-commit` sent to agent, waiting for patches or applying |
| `completed` | Commit completed successfully |
| `failed` | Commit failed. Check `commitError` for details. |

### Session Commit Fields

| Field | Type | Description |
|-------|------|-------------|
| `commitStatus` | string | Current commit state |
| `commitError` | string | Error message if `commitStatus = "failed"` |
| `baseCommit` | string | Workspace commit SHA when commit started (expected parent) |
| `appliedCommit` | string | Final commit SHA after patches applied to workspace |

---

## Commit Flow

### 1. User Clicks Commit Button

**API**: `POST /api/projects/{projectId}/sessions/{sessionId}/commit`

1. Get current commit SHA of the workspace (from git)
2. Save as `baseCommit` on session
3. Clear `appliedCommit` and `commitError`
4. Set `commitStatus` to `pending`
5. Fire `session_updated` SSE event
6. Enqueue `session_commit` job

### 2. Job Execution (PerformCommit)

```go
func PerformCommit(ctx, projectID, sessionID) error {
    session := getSession(sessionID)

    // Idempotency: Skip if already completed
    if session.CommitStatus == "completed" {
        return nil
    }

    // Check baseCommit still matches workspace (handles server restart)
    currentCommit := getWorkspaceCurrentCommit(session.WorkspaceID)
    if session.BaseCommit != currentCommit {
        setCommitFailed(session, "Workspace has changed since commit started")
        return nil
    }

    // Step 1: Send /octobot-commit to agent (if pending)
    if session.CommitStatus == "pending" {
        err := sendChatMessage(sessionID, "/octobot-commit " + session.BaseCommit)
        if err != nil {
            setCommitFailed(session, "Failed to send commit command: " + err.Error())
            return nil
        }
        // Wait for stream to close (turn complete)

        session.CommitStatus = "committing"
        updateSession(session)
        fireSessionUpdatedEvent(projectID, sessionID)
    }

    // Step 2: Fetch and apply patches (if not yet done)
    if session.AppliedCommit == "" {
        // Call agent-api to get format-patch output
        patches, err := agentAPI.GetCommits(sessionID, session.BaseCommit)
        if err != nil {
            setCommitFailed(session, "Failed to get commits: " + err.Error())
            return nil
        }

        if patches.ParentMismatch {
            setCommitFailed(session, "Agent commits have wrong parent")
            return nil
        }

        if len(patches.Data) == 0 {
            setCommitFailed(session, "No commits from agent")
            return nil
        }

        // Apply patches to workspace (git am)
        finalCommit, err := applyPatches(session.WorkspaceID, patches.Data)
        if err != nil {
            setCommitFailed(session, "Failed to apply patches: " + err.Error())
            return nil
        }

        session.AppliedCommit = finalCommit
        updateSession(session)
        fireSessionUpdatedEvent(projectID, sessionID)
    }

    // Step 3: Verify and complete
    if commitExistsInWorkspace(session.WorkspaceID, session.AppliedCommit) {
        session.CommitStatus = "completed"
        session.CommitError = ""
        updateSession(session)
        fireSessionUpdatedEvent(projectID, sessionID)
    } else {
        setCommitFailed(session, "Applied commit not found in workspace")
    }

    return nil
}

func setCommitFailed(session, errorMsg) {
    session.CommitStatus = "failed"
    session.CommitError = errorMsg
    updateSession(session)
    fireSessionUpdatedEvent(session.ProjectID, session.ID)
}
```

### 3. Agent-API Endpoint

```
GET /commits?parent={expectedParent}
```

**Response (success)**:
```json
{
    "patches": "<git format-patch output>",
    "commitCount": 2
}
```

**Response (error)**:
```json
{
    "error": "parent_mismatch" | "no_commits"
}
```

- Uses `git format-patch` to preserve all metadata (author, date, signatures)
- Validates that the commits' parent matches the expected parent
- Returns patches in order, ready for `git am`

### 4. Apply Patches to Workspace

```bash
# In workspace directory
git am --keep-cr < patches.patch
```

- Applies commits exactly as-is with original metadata
- Preserves commit signatures if present
- Returns the final commit SHA

---

## Idempotency

The job is designed to handle server restarts safely:

| Job restarts when... | State | Action |
|---------------------|-------|--------|
| Before sending to agent | `pending`, `appliedCommit=""` | Check baseCommit matches, send `/octobot-commit` |
| After sending, before apply | `committing`, `appliedCommit=""` | Check baseCommit matches, fetch patches, apply |
| After apply, before complete | `committing`, `appliedCommit` set | Verify commit exists, mark `completed` |
| Already done | `completed` | No-op |
| Workspace changed | Any | Set `failed` with error |

**Key idempotency checks**:
1. Always verify `baseCommit` matches current workspace commit before proceeding
2. `appliedCommit` being set indicates patches were applied
3. Agent is idempotent: `/octobot-commit` sent twice returns same patches

---

## Error Handling

| Error | Result | User Action |
|-------|--------|-------------|
| Workspace changed since commit started | `failed` + error message | Click Commit to retry with new baseCommit |
| Agent-api returns no commits | `failed` + error message | Click Commit to retry |
| Agent-api parent mismatch | `failed` + error message | Click Commit to retry |
| Patch application fails | `failed` + error message | Click Commit to retry |
| Verification fails | `failed` + error message | Click Commit to retry |

User can always click Commit again to retry - it starts fresh with a new `baseCommit`.

---

## Chat Behavior

| Session Status | Commit Status | Chat Allowed |
|---------------|---------------|--------------|
| Any | `pending` | **No** - Input disabled |
| Any | `committing` | **No** - Input disabled |
| `ready` | `""` / `completed` / `failed` | Yes |
| `stopped` | `""` / `completed` / `failed` | Yes (restarts sandbox) |
| `error` | Any | No |

---

## SSE Events

All `commitStatus` changes fire `session_updated` SSE event:

```json
{
    "type": "session_updated",
    "data": {
        "sessionId": "abc123",
        "status": ""
    }
}
```

Client re-fetches session to get updated `commitStatus`, `commitError`, `appliedCommit`.

---

## Implementation Components

### Backend

| Component | File | Changes |
|-----------|------|---------|
| Model | `server/internal/model/model.go` | Add `CommitError`, `BaseCommit`, `AppliedCommit` fields |
| Service | `server/internal/service/session.go` | Update `CommitSession()`, `PerformCommit()` |
| Job | `server/internal/jobs/session_commit.go` | Already exists, update executor |
| Git | `server/internal/service/git.go` | Add `ApplyPatches()` method |
| Handler | `server/internal/handler/chat.go` | Block chat during commit |

### Agent-API

| Component | File | Changes |
|-----------|------|---------|
| Handler | `agent-api/internal/server/commits.go` | New endpoint |
| Git | `agent-api/internal/...` | `git format-patch` execution |

### Frontend

| Component | File | Changes |
|-----------|------|---------|
| Types | `lib/api-types.ts` | Add `commitError`, `baseCommit`, `appliedCommit` |
| Chat Panel | `components/ide/chat-panel.tsx` | Display `commitError` |
| Sidebar | `components/ide/sidebar-tree.tsx` | Show failed state |

---

## Database Schema

```sql
ALTER TABLE sessions ADD COLUMN commit_error TEXT DEFAULT '';
ALTER TABLE sessions ADD COLUMN base_commit TEXT DEFAULT '';
ALTER TABLE sessions ADD COLUMN applied_commit TEXT DEFAULT '';
```
