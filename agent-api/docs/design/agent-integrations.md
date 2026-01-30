# Agent Integrations

This document describes Discobot-specific integration points with AI coding agents. These integrations extend beyond the standard ACP protocol to provide tighter workflow integration.

## Overview

While ACP defines the wire protocol for agent communication, Discobot provides additional integration points that agents can leverage for enhanced functionality. These integrations are agent-specific and must be implemented separately for each supported agent.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Discobot Container                           │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  Agent Configuration                     │   │
│  │                                                          │   │
│  │  ~/.claude/commands/     ← Claude Code custom commands   │   │
│  │  ~/.opencode/commands/   ← OpenCode custom commands      │   │
│  │  ~/.gemini/commands/     ← Gemini CLI custom commands    │   │
│  │                                                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    ACP Agent                             │   │
│  │                                                          │   │
│  │  Reads agent-specific config and exposes commands        │   │
│  │  to the user via slash commands or other mechanisms      │   │
│  │                                                          │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Custom Commands

### Purpose

Custom commands allow Discobot to expose agent-invocable actions that integrate with the container workflow. For example, committing changes back to the parent workspace requires specific knowledge of Discobot's architecture.

### Claude Code Implementation

Claude Code supports custom slash commands via markdown files in `~/.claude/commands/`.

**Location in container:** `/home/discobot/.claude/commands/`

**Source location:** `container-assets/claude/commands/`

#### Command Format

Commands use YAML frontmatter followed by markdown instructions:

```yaml
---
name: command-name
description: Brief description for the command menu
argument-hint: <arg-description>
disable-model-invocation: true  # Prevent auto-invocation
---

Instructions for the agent when this command is invoked.

Use $ARGUMENTS to reference the argument passed by the user.
```

### Discobot Commands

#### /discobot-commit

Commits session changes back to the parent workspace.

**File:** `container-assets/claude/commands/discobot-commit.md`

**Invoked by:** Go server (`server/internal/service/session.go`) when user clicks the Commit button.

**Purpose:** When a session is ready to be committed, this command instructs the agent to:
1. Analyze all changes made during the session
2. Rebase onto a target commit if necessary (the parent workspace may have advanced)
3. Create appropriate git commits with clear messages

**Usage:** `/discobot-commit <target-commit-id>`

The Go server sends this command as a chat message: `/discobot-commit <baseCommit>` where `baseCommit` is the commit SHA the workspace was at when the session started.

**Why this is needed:** The container's workspace is a copy/clone of the parent workspace. When committing, the agent needs to handle the case where the parent has received new commits since the session started.

## Implementing for Other Agents

When adding support for a new ACP agent, these integration points must be implemented:

### 1. Custom Commands

| Agent | Config Location | Format |
|-------|-----------------|--------|
| Claude Code | `~/.claude/commands/` | YAML frontmatter + Markdown |
| OpenCode | TBD | TBD |
| Gemini CLI | TBD | TBD |

**Steps to add command support:**

1. Research how the agent handles custom commands/skills
2. Create equivalent command files in `container-assets/<agent>/commands/`
3. Update Dockerfile to copy the config to the appropriate location
4. Test that the command appears and functions correctly

### 2. Required Commands

All agents should implement equivalent functionality for:

| Command | Purpose |
|---------|---------|
| `discobot-commit` | Commit session changes to parent workspace |

### 3. Container Assets Structure

```
container-assets/
├── claude/
│   └── commands/
│       └── discobot-commit.md
├── opencode/           # Future
│   └── commands/
└── gemini/             # Future
    └── commands/
```

### 4. Dockerfile Updates

Each agent's configuration must be copied to the correct location:

```dockerfile
# Claude Code
COPY --chown=discobot:discobot container-assets/claude /home/discobot/.claude

# OpenCode (example)
COPY --chown=discobot:discobot container-assets/opencode /home/discobot/.opencode
```

## Environment Variables

Agents may need environment variables to enable certain features:

| Variable | Agent | Purpose |
|----------|-------|---------|
| `CLAUDE_CODE_ENABLE_HOOKS` | Claude Code | Enable lifecycle hooks |
| `ANTHROPIC_API_KEY` | Claude Code | API authentication |

## Testing Integrations

### Manual Testing

1. Start a container with the agent
2. Verify the command appears in the agent's command list
3. Invoke the command and verify behavior

### Automated Testing

Integration tests should verify:
- Command files are copied to the correct location
- Commands are recognized by the agent
- Commands execute with expected behavior

## Future Integrations

Potential future integration points:

- **Lifecycle hooks**: Agent callbacks for session start/end
- **Status reporting**: Agent-to-Discobot status updates
- **Resource limits**: Agent awareness of container constraints
- **MCP servers**: Pre-configured MCP servers for Discobot tools
