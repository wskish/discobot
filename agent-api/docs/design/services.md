# Services Module

The services module manages user-defined services in the agent container. Services are files in the `.discobot/services/` directory that can be started, stopped, and monitored via the API.

## Overview

Services are defined as files in the `workspace/.discobot/services/` directory. Each service can have optional YAML front matter to configure display name, description, and HTTP/HTTPS port bindings.

There are two types of services:

1. **Executable Services**: Scripts that are started and stopped by the agent. Must be executable files with a shebang line and a script body.

2. **Passive Services**: HTTP endpoint declarations for services managed externally. These files only contain front matter (no script body) and declare an HTTP/HTTPS port. They don't need to be executable.

## Service Definition

### File Location

```
workspace/.discobot/services/
├── my-server        # Executable service file
├── api-backend      # Another service
└── dev-proxy        # etc.
```

### Front Matter Format

Services support YAML front matter with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Display name (defaults to filename) |
| `description` | string | No | Human-readable description |
| `http` | number | No | HTTP port the service listens on |
| `https` | number | No | HTTPS port the service listens on |
| `path` | string | No | Default URL path for web preview (e.g., "/app" or "/api/docs") |

**Note:** The `passive` field is computed automatically based on whether the file has a script body. You don't need to specify it in the front matter.

### Front Matter Delimiters

The front matter can be written in three styles:

**Plain (for scripts that ignore unknown content):**
```bash
#!/bin/bash
---
name: My Service
http: 8080
---
exec python server.py
```

**Hash-prefixed (for shell scripts):**
```bash
#!/bin/bash
#---
# name: My Service
# http: 8080
#---
exec python server.py
```

**Slash-prefixed (for other languages):**
```javascript
#!/usr/bin/env node
//---
// name: Node Service
// http: 3000
//---
require('./server').start();
```

### Whitespace Rules

For comment-prefixed styles (`#---` or `//---`), any whitespace after the prefix is trimmed:

```bash
#---
# name: Foo        # 1 space - trimmed
#   http: 8080     # 3 spaces - trimmed
#      description: Many spaces - also trimmed
#---
```

All of the above are valid and equivalent. Empty lines are always allowed.

## Passive Services

Passive services declare an HTTP endpoint without providing a script to run. They're useful when:

- A service is started by the development environment (e.g., `devcontainer.json`)
- A service is managed by another process (e.g., docker-compose)
- You want to expose an externally-managed port through the service proxy

### Passive Service Example

Create a file `.discobot/services/webapp` (no extension needed, doesn't need to be executable):

```yaml
---
name: Web App
description: Frontend dev server (started by devcontainer)
http: 3000
---
```

The file must:
- Have front matter with `http` or `https` port defined
- Have an empty body (only whitespace after the closing `---`)

The file does NOT need:
- A shebang line (`#!/bin/bash`)
- Execute permissions
- Any script content

### Passive Service Behavior

- Always shown with `status: "stopped"` (no process to track)
- `passive: true` in the API response
- Start/stop/output API calls return `400` with `error: "service_is_passive"`
- HTTP proxy still works if the port is accessible

## API Endpoints

### List Services

```
GET /services
```

Returns all discovered services with their current status.

**Response:**
```json
{
  "services": [
    {
      "id": "my-server",
      "name": "My Server",
      "description": "Development server",
      "http": 8080,
      "path": "/workspace/.discobot/services/my-server",
      "status": "running",
      "pid": 12345,
      "startedAt": "2024-01-15T10:30:00Z"
    },
    {
      "id": "webapp",
      "name": "Web App",
      "description": "Frontend (external)",
      "http": 3000,
      "path": "/workspace/.discobot/services/webapp",
      "status": "stopped",
      "passive": true
    }
  ]
}
```

### Start Service

```
POST /services/:id/start
```

Starts a service. Returns 202 Accepted immediately; the service spawns asynchronously.

**Response (202):**
```json
{
  "status": "starting",
  "serviceId": "my-server"
}
```

**Error (409 - already running):**
```json
{
  "error": "service_already_running",
  "serviceId": "my-server",
  "pid": 12345
}
```

### Stop Service

```
POST /services/:id/stop
```

Stops a running service. Sends SIGTERM, then SIGKILL after 5 seconds if needed.

**Response (200):**
```json
{
  "status": "stopped",
  "serviceId": "my-server"
}
```

### Stream Output

```
GET /services/:id/output
```

Streams service stdout/stderr via Server-Sent Events (SSE).

**Event Format:**
```
data: {"type":"stdout","data":"Server started\n","timestamp":"..."}
data: {"type":"stderr","data":"Warning: ...\n","timestamp":"..."}
data: {"type":"exit","exitCode":0,"timestamp":"..."}
data: [DONE]
```

Features:
- Replays stored output from file on connect
- Streams live output until service exits
- Sends `[DONE]` when service stops

### HTTP Proxy

```
ALL /services/:id/http/*
```

HTTP reverse proxy to the service's HTTP/HTTPS port.

**Requirements:**
- Service must have `http` or `https` configured
- Service must be running

**Headers:**
- `x-forwarded-path`: Override the request path sent to the service
- `x-forwarded-for`: Client IP (preserved/set automatically)
- `x-forwarded-host`: Original host header (preserved/set automatically)
- `x-forwarded-proto`: Original protocol (preserved/set automatically)

**Behavior:**
- Supports all HTTP methods (GET, POST, PUT, DELETE, etc.)
- Streams request and response bodies
- Does not follow redirects (returns them to client)
- Returns 502 on connection errors

## State Management

### In-Memory State

Running services are tracked in memory:

```typescript
interface ManagedService {
  service: Service;       // Service metadata + status
  process: ChildProcess;  // Node.js process handle
  eventEmitter: EventEmitter;  // For SSE streaming
}
```

### Output Storage

Service output is persisted to disk for durability:

```
~/.config/discobot/services/output/{id}.out
```

- Format: JSONL (newline-delimited JSON)
- Each line is a `ServiceOutputEvent`
- Max file size: 1MB (auto-truncated, keeps last half)
- Output is cleared when service starts
- Persists across agent restarts

### Lifecycle States

```
stopped → starting → running → stopping → stopped
                         ↓
                       error → stopped
```

### Grace Period

Stopped services remain in memory for 30 seconds to allow:
- Live streaming to continue after exit
- Status queries

After the grace period, the service is removed from memory but output remains on disk.

## Module Structure

```
src/services/
├── parser.ts    # Front matter parsing
├── output.ts    # File-based output storage
├── manager.ts   # Process lifecycle management
└── proxy.ts     # WebSocket TCP proxy
```

### Parser Module

- `parseFrontMatter(content)` - Parse YAML front matter from file content
- `discoverServices(dir)` - Scan directory for service files

### Output Module

- `getOutputPath(serviceId)` - Get file path for service output
- `appendEvent(serviceId, event)` - Append event to output file
- `readEvents(serviceId)` - Read all events from file
- `clearOutput(serviceId)` - Clear output file (on service start)
- `truncateIfNeeded(serviceId)` - Truncate file if over 1MB
- `create*Event()` - Factory functions for event types

### Manager Module

- `getServices(workspaceRoot)` - List all services with status
- `getService(workspaceRoot, id)` - Get single service
- `startService(workspaceRoot, id)` - Start a service (clears previous output)
- `stopService(id)` - Stop a service
- `getManagedService(id)` - Get internal state for streaming
- `getServiceOutput(serviceId)` - Read output from file

### Proxy Module

- `proxyHttpRequest(c, port)` - HTTP reverse proxy to service port

## Subdomain Proxy (Go Server)

The Go server includes middleware that intercepts requests to service subdomains and proxies them to the agent-api's HTTP proxy endpoint.

### Subdomain Format

```
{session-id}-svc-{service-id}.{base-domain}
```

Example: `01HXYZ123456789ABCDEFGHIJ-svc-myservice.localhost:3000`

### Middleware Behavior

1. Parses the `Host` header for the pattern `([0-9A-Za-z]{26})-svc-([a-zA-Z0-9_.-]+)\.`
2. Extracts `session-id` and `service-id` from the subdomain
3. Gets HTTP client for the sandbox via the sandbox provider
4. Proxies request to `/services/{service-id}/http{original-path}` on agent-api
5. Sets `x-forwarded-path` to the original request path
6. Does NOT pass credentials (Authorization, X-Discobot-Credentials headers)

### Security Notes

- Service HTTP endpoints are considered public within the sandbox
- Credentials are deliberately not forwarded
- The proxy validates the session exists via the sandbox provider

### UI Integration

For HTTP services, the UI renders a `<WebPreview>` component that:
- Builds URL: `${protocol}//${sessionId}-svc-${serviceId}.${window.location.host}/`
- Renders iframe with the service content
- Provides refresh and open-in-new-tab controls
- Allows toggling between preview and logs view

## Error Handling

| Error | HTTP Status | Response |
|-------|-------------|----------|
| Service not found | 404 | `{"error": "service_not_found", "serviceId": "..."}` |
| Already running | 409 | `{"error": "service_already_running", "serviceId": "...", "pid": N}` |
| Not running | 400 | `{"error": "service_not_running", "serviceId": "..."}` |
| No port configured | 400 | `{"error": "service_no_port", "serviceId": "..."}` |
| Passive service | 400 | `{"error": "service_is_passive", "serviceId": "...", "message": "..."}` |
| Connection refused | 503 | `{"error": "connection_refused", "port": N, "message": "..."}` (or HTML page for browsers) |

Invalid front matter is logged as a warning and treated as empty config.
