# Theming Module

This document describes the theming system, design tokens, and how components adapt to light/dark modes.

## Files

| File | Description |
|------|-------------|
| `app/globals.css` | CSS custom properties and theme tokens |
| `components/theme-provider.tsx` | next-themes wrapper |
| `components/ide/theme-toggle.tsx` | Theme switcher UI |
| `components/ide/icon-renderer.tsx` | Theme-aware icon display |

## Theme Provider

### Setup

The `ThemeProvider` wraps the app in `layout.tsx`:

```tsx
// app/layout.tsx
import { ThemeProvider } from "@/components/theme-provider"

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
```

### Configuration

| Option | Value | Description |
|--------|-------|-------------|
| `attribute` | `"class"` | Adds `dark` class to `<html>` |
| `defaultTheme` | `"system"` | Uses OS preference |
| `enableSystem` | `true` | Respects `prefers-color-scheme` |
| `disableTransitionOnChange` | `true` | No transition on toggle |

## Design Tokens

### Color Tokens (globals.css)

```css
:root {
  /* Base colors */
  --background: oklch(98% 0 0);
  --foreground: oklch(15% 0 0);

  /* Component colors */
  --card: oklch(98% 0 0);
  --card-foreground: oklch(15% 0 0);
  --popover: oklch(98% 0 0);
  --popover-foreground: oklch(15% 0 0);

  /* Interactive colors */
  --primary: oklch(35% 0 0);
  --primary-foreground: oklch(98% 0 0);
  --secondary: oklch(95% 0 0);
  --secondary-foreground: oklch(35% 0 0);
  --muted: oklch(95% 0 0);
  --muted-foreground: oklch(55% 0 0);
  --accent: oklch(95% 0 0);
  --accent-foreground: oklch(35% 0 0);

  /* State colors */
  --destructive: oklch(55% 0.2 25);
  --destructive-foreground: oklch(98% 0 0);

  /* Border and input */
  --border: oklch(90% 0 0);
  --input: oklch(90% 0 0);
  --ring: oklch(35% 0 0);
}

.dark {
  /* Dark mode overrides */
  --background: oklch(10% 0 0);
  --foreground: oklch(95% 0 0);
  /* ... all colors inverted */
}
```

### IDE-Specific Tokens

```css
:root {
  /* Sidebar */
  --sidebar: oklch(96% 0 0);
  --sidebar-foreground: oklch(15% 0 0);

  /* Tree view */
  --tree-hover: oklch(93% 0 0);
  --tree-selected: oklch(90% 0.05 230);

  /* Terminal */
  --terminal-bg: oklch(10% 0 0);
  --terminal-foreground: oklch(85% 0 0);

  /* Diff view */
  --diff-add: oklch(85% 0.1 140);
  --diff-remove: oklch(85% 0.1 25);
  --diff-change: oklch(85% 0.1 70);
}

.dark {
  --sidebar: oklch(12% 0 0);
  --tree-hover: oklch(18% 0 0);
  --tree-selected: oklch(25% 0.05 230);
  /* ... */
}
```

## Token Usage

### In Tailwind Classes

```tsx
// Use token-based classes
<div className="bg-background text-foreground">
<button className="bg-primary text-primary-foreground">
<span className="text-muted-foreground">

// IDE tokens
<div className="bg-sidebar">
<div className="bg-tree-hover">
<span className="bg-diff-add">
```

### In CSS

```css
.custom-element {
  background: var(--background);
  color: var(--foreground);
  border-color: var(--border);
}
```

## ThemeToggle Component

A simple toggle between light/dark modes:

```tsx
// components/ide/theme-toggle.tsx
import { useTheme } from "next-themes"
import { Moon, Sun } from "lucide-react"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(theme === "light" ? "dark" : "light")}
    >
      <Sun className="h-4 w-4 dark:hidden" />
      <Moon className="h-4 w-4 hidden dark:block" />
    </Button>
  )
}
```

## Theme-Aware Icons

### Icon Format

Icons from the API include theme variants:

```typescript
interface Icon {
  src: string        // data: URI or URL
  mimeType?: string  // image/svg+xml, etc.
  sizes?: string[]   // ["48x48", "any"]
  theme?: "light" | "dark"
}
```

### IconRenderer Logic

```typescript
function IconRenderer({ icons, size = 16 }: IconRendererProps) {
  const { resolvedTheme } = useTheme()

  // 1. Find theme-matched icon
  const themedIcon = icons.find(i => i.theme === resolvedTheme)

  // 2. Fall back to unthemed
  const icon = themedIcon ?? icons.find(i => !i.theme) ?? icons[0]

  // 3. Handle SVGs with currentColor
  if (icon.mimeType === 'image/svg+xml' && usesCurrentColor(icon.src)) {
    return <InlineSvg src={icon.src} size={size} />
  }

  // 4. Render as image
  return <img src={icon.src} width={size} height={size} />
}
```

### SVG currentColor Handling

SVGs that use `currentColor` must be rendered inline to inherit the text color:

```tsx
function InlineSvg({ src, size }: { src: string, size: number }) {
  // Extract SVG content from data URI
  const svgContent = decodeDataUri(src)

  return (
    <span
      className="inline-flex"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svgContent }}
    />
  )
}
```

## Terminal Theming

The terminal uses xterm.js theme configuration:

```typescript
const terminalTheme = {
  background: getComputedStyle(document.documentElement)
    .getPropertyValue('--terminal-bg'),
  foreground: getComputedStyle(document.documentElement)
    .getPropertyValue('--terminal-foreground'),
  cursor: 'var(--terminal-cursor)',
  // ... ANSI colors
}
```

## Diff View Theming

Diff highlighting uses dedicated tokens:

```css
.diff-line-added {
  background: var(--diff-add);
}

.diff-line-removed {
  background: var(--diff-remove);
}

.diff-line-changed {
  background: var(--diff-change);
}
```

## Dark Mode Transitions

By default, transitions are disabled to prevent flash:

```tsx
<ThemeProvider disableTransitionOnChange>
```

To enable smooth transitions:

```css
/* Only if desired */
* {
  transition: background-color 150ms ease, color 150ms ease;
}
```

## Color Space

The theme uses OKLCH color space for perceptually uniform colors:

```css
/* OKLCH: lightness, chroma, hue */
--primary: oklch(35% 0 0);     /* Dark gray, no saturation */
--accent: oklch(60% 0.15 230); /* Blue accent */
```

Benefits:
- Consistent perceived lightness
- Easier to create accessible contrast
- Better gradients and color mixing

## Accessibility

### Contrast Requirements

- Text: 4.5:1 minimum contrast ratio
- Large text: 3:1 minimum
- Interactive elements: 3:1 for boundaries

### Focus Indicators

```css
:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
```

### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    transition: none !important;
  }
}
```

## Testing Themes

To test both themes:
1. Use browser dev tools to toggle `dark` class
2. Use system preference in OS settings
3. Use ThemeToggle component
4. Automated visual regression tests
