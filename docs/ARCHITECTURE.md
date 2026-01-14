# UI Architecture

This document describes the architecture of the Octobot frontend, a Next.js 16 application that provides an IDE-like chat interface for AI coding agents.

## Overview

The UI is a single-page application built with React 19 and Next.js App Router. It renders an IDE-style interface with resizable panels for workspace navigation, chat/terminal, and file diffs.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Header (logo, controls)                     │
├─────────────────────────────────────────────────────────────────┤
│ Left Sidebar  │              Main Content                        │
│ ┌───────────┐ │  ┌─────────────────────────────────────────┐    │
│ │ Workspace │ │  │           Diff Panel (tabs)             │    │
│ │   Tree    │ │  ├─────────────────────────────────────────┤    │
│ ├───────────┤ │  │        Bottom Panel                     │    │
│ │  Agents   │ │  │     (Chat or Terminal)                  │    │
│ │   Panel   │ │  └─────────────────────────────────────────┘    │
│ └───────────┘ │                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
app/
├── layout.tsx           # Root layout with providers
├── page.tsx            # Main IDE page orchestration
├── globals.css         # Theme tokens and Tailwind config
└── api/                # API routes (minimal, proxied to Go server)

components/
├── ai-elements/        # Vercel AI SDK UI wrappers
├── ide/               # IDE-specific components
│   ├── layout/        # Panel layout components
│   └── *.tsx          # Feature components
└── ui/                # shadcn/ui base components

lib/
├── api-client.ts      # REST API client
├── api-types.ts       # TypeScript interfaces
├── api-config.ts      # API configuration
├── hooks/             # Custom React hooks
└── plugins/           # Auth provider plugins
```

## Module Documentation

- [Layout Module](./design/layout.md) - Panel system and page composition
- [Chat Module](./design/chat.md) - AI chat integration with Vercel AI SDK
- [Data Layer](./design/data-layer.md) - SWR hooks and API client
- [Components Module](./design/components.md) - UI component organization
- [Theming Module](./design/theming.md) - Theme system and design tokens

## Key Architectural Decisions

### 1. No File-based Routing for IDE Panels

The application uses a single `page.tsx` that manages all IDE state. Panel content is driven by React state (`selectedSession`, `openTabs`, etc.) rather than URL routes. This provides a desktop-like IDE experience.

### 2. SWR for Server State

All server data is managed through SWR hooks in `lib/hooks/`. This provides:
- Automatic caching and revalidation
- Optimistic updates via mutations
- Built-in loading and error states

### 3. API Proxy to Go Backend

API calls go to `/api/*` which Next.js rewrites to the Go backend at `localhost:3001`. This allows the frontend to use relative URLs while the backend handles business logic.

### 4. Server-Sent Events for Real-time Updates

The `useProjectEvents` hook subscribes to SSE from the backend. When session/workspace status changes, it triggers SWR mutations to refresh the affected resources.

### 5. Vercel AI SDK for Chat

Chat uses the `useChat` hook from `@ai-sdk/react`. Messages stream via SSE and support custom UI parts for tool invocations and reasoning.

## Data Flow

### User Initiates Chat

```
1. User types message in ChatPanel
2. useChat sends POST /api/chat (proxied to Go server)
3. Go server creates session, starts container
4. Go server proxies to container's /chat endpoint
5. Container streams SSE response
6. useChat updates messages state
7. React re-renders with new content
```

### Real-time Updates

```
1. Backend emits SSE event (session status changed)
2. useProjectEvents receives event
3. Hook calls SWR mutate() for affected resource
4. SWR refetches from API
5. React re-renders with fresh data
```

### Panel State Persistence

```
1. User resizes/collapses panels
2. ResizeHandle callback updates state
3. usePersistedState syncs to localStorage
4. On page reload, state restored from localStorage
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `next` | App framework with routing and SSR |
| `react` | UI library |
| `ai`, `@ai-sdk/react` | Vercel AI SDK for chat |
| `swr` | Data fetching and caching |
| `@radix-ui/*` | Accessible UI primitives |
| `tailwindcss` | Utility-first CSS |
| `next-themes` | Theme switching |
| `@xterm/xterm` | Terminal emulator |
| `lucide-react` | Icons |
