# Klawd Nexus

A desktop command center for managing multiple Claude Code terminal sessions simultaneously. Built for power users who run several Claude Code agents across different projects and need a single pane of glass to orchestrate them all.

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

**Multi-Agent Terminal Management**
- Run unlimited Claude Code agents in parallel, each in its own project directory
- Switch between agents instantly with keyboard shortcuts (Cmd+1-9)
- Focus mode (Cmd+Shift+F) for distraction-free single-agent work

**General Manager View**
- Centralized question queue: all agent prompts in one sidebar
- Bulk reply: answer all permission prompts at once (Cmd+Shift+Y)
- Auto-reply rules: automatically accept tool permissions per-agent or globally
- Live status indicators: see which agents are active, waiting, idle, or errored

**Smart Question Detection**
- Dual-timer system detects Claude Code's permission prompts within 600ms
- Handles both selection menus (Enter to confirm) and text prompts (y/n)
- Extracts the actual question text intelligently (sentence boundary to question mark)
- Filters out Claude Code's UI chrome (status bar, separators, spinner characters)

**Productivity Features**
- Cmd+K command palette with fuzzy search (agents, actions, workspaces, snippets)
- Saved snippets for common commands ("commit changes", "run tests", etc.)
- Command history with up/down arrow recall and autocomplete suggestions
- Workspace presets: save and restore your full agent fleet with one click
- Session export to Markdown for documentation
- Cross-agent search: find text across all terminal buffers at once

**File Preview**
- Built-in file browser (Cmd+B) with directory navigation
- Syntax-highlighted file preview in a horizontal split above the terminal
- Drag-and-drop file paths into the input bar
- Hidden files toggle (Cmd+H)

**Remote Access (Phone Control)**
- One-click Cloudflare tunnel for secure HTTPS access from anywhere
- Mobile-optimized view with agent list, live chat, and question replies
- QR code for instant phone connection
- PIN authentication for security
- Create new agents remotely from your phone

**MCP Server Manager**
- Visual interface to add, remove, and configure MCP servers
- Reads/writes directly to ~/.mcp.json
- No more typing /mcp commands in the terminal

**Desktop App**
- Native Electron wrapper with custom icon
- macOS traffic light integration
- No browser chrome, dedicated dock icon

## Install (One Command)

**macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/chriscode138/klawd-nexus/main/install-mac.sh | bash
```
This installs everything, creates a **Klawd Nexus.app** in your Applications folder, and you're done. Open it like any other app.

**Windows:**
1. Download [install-windows.bat](https://raw.githubusercontent.com/chriscode138/klawd-nexus/main/install-windows.bat)
2. Double-click it
3. A desktop shortcut is created automatically

**Prerequisites:** [Node.js](https://nodejs.org) v18+ and [Git](https://git-scm.com). That's it.

## Manual Install

```bash
git clone https://github.com/chriscode138/klawd-nexus.git
cd klawd-nexus
npm install

# Run as desktop app
npm run app

# Or run in browser
npm start
# Then open http://localhost:3000

# Custom port
PORT=4000 npm start
```

## Requirements

- Node.js 18+ (tested on 24.x)
- Claude Code CLI installed and in your PATH
- macOS or Windows

### Optional
- `cloudflared` for remote access: `brew install cloudflare/cloudflare/cloudflared` (macOS) or [download](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (Windows)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+N / Cmd+T | New agent |
| Cmd+1-9 | Switch to agent by index |
| Cmd+Shift+] / [ | Next / previous agent |
| Cmd+K | Command palette |
| Cmd+F | Search current terminal |
| Cmd+B | Toggle file browser |
| Cmd+H | Toggle hidden files |
| Cmd+J | Focus next pending question |
| Cmd+Shift+Y | Accept all pending questions |
| Cmd+Shift+F | Focus / zen mode |
| Cmd+M | Mute / unmute sounds |
| Cmd+W | Close current agent |
| Cmd+A | Select all agents (for batch commands) |
| ? | Keyboard shortcut cheat sheet |
| Up / Down | Command history in input |
| Shift+Enter | New line in input |

## Architecture

```
klawd-nexus/
  electron.js       # Electron main process (desktop app wrapper)
  server.js          # Express + WebSocket + node-pty server
  src/app.js         # Frontend application (bundled by esbuild)
  public/
    index.html       # Desktop UI
    mobile.html      # Mobile-optimized remote view
    login.html       # PIN authentication page
    css/theme.css    # Complete dark theme
    manifest.json    # PWA manifest for mobile
```

- **Backend**: Express serves the UI and REST APIs. WebSocket handles real-time terminal I/O. node-pty manages pseudo-terminal sessions.
- **Frontend**: Vanilla JS bundled by esbuild. xterm.js for terminal rendering. No framework dependencies.
- **Mobile**: Standalone HTML page with WebSocket connection. Works as a PWA (add to home screen).

## Data Storage

- Workspaces: `~/.klawd-nexus/workspaces.json`
- Config/PIN: `~/.klawd-nexus/config.json`
- MCP servers: `~/.mcp.json` (Claude Code's native config)
- UI preferences (sidebar width, mute state, snippets, etc.): browser localStorage

## License

MIT
