# React DevTools Integration

This document explains how to enable React DevTools integration in Discobot.

## Overview

Discobot supports conditionally loading the React DevTools script in the browser by setting an environment variable.

**Note**: For regular web browser development, you should use the [React Developer Tools browser extension](https://react.dev/learn/react-developer-tools) (available for Chrome, Firefox, and Edge). The standalone React DevTools setup described here is **specifically for Tauri desktop app development**, where browser extensions cannot be used.

## Why Use Standalone React DevTools for Tauri?

When developing the Tauri desktop application, the standalone React DevTools are essential because:

- **Browser extensions don't work in Tauri**: Tauri uses a native webview, not a full browser, so browser extensions like React DevTools cannot be installed
- **Full component inspection**: You get the same powerful component tree inspection, props/state viewing, and profiling capabilities as the browser extension
- **Separate window**: DevTools run in their own window, giving you more screen space for your app
- **Works across all webviews**: Whether you're using Tauri, Electron, or native mobile webviews, the standalone DevTools work the same way

For web browser development (`pnpm dev`), just install the React DevTools browser extension instead of following this guide.

## Setup

### 1. Install React DevTools Standalone

Install the standalone React DevTools globally using npm:

```bash
npm install -g react-devtools
```

This installs a cross-platform desktop application that runs separately from your browser. The DevTools communicate with your React app via a local server connection.

### 2. Start React DevTools Server

Launch the standalone DevTools application:

```bash
react-devtools
```

This will:
- Open a standalone DevTools window
- Start a server on `http://localhost:8097` by default
- Wait for your React application to connect

You can customize the port if needed:

```bash
react-devtools --port 9000
```

### 3. Configure Environment Variable

Create a `.env.local` file in the root directory (copy from `.env.local.example`):

```bash
cp .env.local.example .env.local
```

The `VITE_REACT_DEVTOOLS_URL` is already set to `http://localhost:8097` in the example file. You can modify it if your DevTools server is running on a different port.

### 4. Start Discobot

```bash
pnpm dev
```

The React DevTools script will be automatically included in the page when the environment variable is set.

## Verification

### For Web Browser Development

1. Open your browser's developer console
2. Look for a message from React DevTools indicating it has connected
3. You should see your React component tree in the standalone DevTools window

### For Tauri Development

1. Build and run your Tauri app: `pnpm tauri dev`
2. The standalone DevTools window should automatically connect
3. You can now inspect React components, view props/state, and profile performance just like you would with the browser extension

The standalone DevTools window will display:
- **Components tab**: Navigate your React component tree
- **Profiler tab**: Record and analyze performance
- Real-time updates as your components re-render

## Disabling React DevTools

To disable React DevTools, simply remove or comment out the `VITE_REACT_DEVTOOLS_URL` environment variable in your `.env.local` file:

```bash
# VITE_REACT_DEVTOOLS_URL=http://localhost:8097
```

## Custom DevTools URL

If your React DevTools server is running on a different port or host, update the environment variable accordingly:

```bash
VITE_REACT_DEVTOOLS_URL=http://localhost:9000
```

## Implementation Details

- The React DevTools script is conditionally included in `src/main.tsx`
- The script is only loaded when `VITE_REACT_DEVTOOLS_URL` is set
- The script is loaded asynchronously to avoid blocking page rendering
- The environment variable is read at build time by Vite

## Troubleshooting

### DevTools Not Connecting

1. Ensure the React DevTools server is running
2. Check that the `VITE_REACT_DEVTOOLS_URL` matches the server URL
3. Restart the Vite development server after changing environment variables
4. Check browser console for any errors

### Script Not Loading

1. Verify the environment variable is set in `.env.local`
2. Restart the development server (`pnpm dev`)
3. Check the page source to confirm the script tag is present

## Tips for Tauri Development

When developing the Tauri desktop app, the standalone React DevTools are essential since browser extensions don't work:

1. **Start DevTools first**: Launch `react-devtools` before starting your Tauri app
2. **Keep it running**: The DevTools can stay open across Tauri app restarts - they'll automatically reconnect
3. **Multiple windows**: You can have DevTools connected to multiple React apps simultaneously (each shows in the window)
4. **Component highlighting**: Click the "Select an element" button in DevTools to highlight components in your Tauri app

## Advanced Configuration

### Custom Port

If you need to run DevTools on a different port (e.g., port 9000):

1. Start DevTools with custom port:
   ```bash
   react-devtools --port 9000
   ```

2. Update your `.env.local`:
   ```bash
   VITE_REACT_DEVTOOLS_URL=http://localhost:9000
   ```

### Connecting Over Network

For debugging on remote devices or VMs, you can expose DevTools on your network:

```bash
react-devtools --host 0.0.0.0
```

Then use your machine's IP address in the environment variable:
```bash
VITE_REACT_DEVTOOLS_URL=http://192.168.1.100:8097
```

## Security Note

React DevTools should only be enabled in development environments. Never deploy to production with this environment variable set, as it could expose internal React component structure and state.

For Tauri production builds, ensure `.env.local` is not included in your build process (it won't be by default, as it's gitignored and not used during `pnpm build:tauri`).
