import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';

// ═══════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════

const TERMINAL_THEME = {
  background:          '#0c0c18',
  foreground:          '#d2d4e6',
  cursor:              '#7c6cf0',
  cursorAccent:        '#0c0c18',
  selectionBackground: 'rgba(124, 108, 240, 0.22)',
  selectionForeground: '#ffffff',
  black:               '#0c0c18',
  red:                 '#ffa0a0',
  green:               '#7aeaac',
  yellow:              '#fcd880',
  blue:                '#88b8ff',
  magenta:             '#d0a8fa',
  cyan:                '#66daea',
  white:               '#d2d4e6',
  brightBlack:         '#707090',
  brightRed:           '#ffbebe',
  brightGreen:         '#a0f0c8',
  brightYellow:        '#ffe8a8',
  brightBlue:          '#b0d0ff',
  brightMagenta:       '#e0c8ff',
  brightCyan:          '#90e8f4',
  brightWhite:         '#f2f2ff',
};

// ═══════════════════════════════════════════
// State
// ═══════════════════════════════════════════

const agents = new Map();
let activeAgentId = null;
let ws = null;
let reconnectTimer = null;
let previewVisible = false;
let previewHistory = [];
let showHiddenFiles = false;
let searchBarVisible = false;
let searchActiveAgentId = null;
const MAX_PREVIEW_HISTORY = 50;
const RECENT_DIRS_KEY = 'claude-nexus-recent-dirs';
const MAX_RECENT_DIRS = 12;
let sidebarDirty = false;
let sidebarRafScheduled = false;
const pendingRestarts = new Map();
const activityLog = [];
const MAX_ACTIVITY_LOG = 200;
let pendingAgentName = null; // For loading spinner

// UX Polish: Command history for floating input
const CMD_HISTORY_KEY = 'nexus-cmd-history';
const MAX_CMD_HISTORY = 50;
let cmdHistory = [];
let cmdHistoryIndex = -1;
let cmdHistoryDraft = '';

function loadCmdHistory() {
  try {
    const stored = localStorage.getItem(CMD_HISTORY_KEY);
    if (stored) cmdHistory = JSON.parse(stored);
  } catch {}
}

function saveCmdHistory() {
  try {
    localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(cmdHistory));
  } catch {}
}

function addToHistory(text) {
  if (!text || !text.trim()) return;
  // Remove duplicate if it exists
  const idx = cmdHistory.indexOf(text);
  if (idx !== -1) cmdHistory.splice(idx, 1);
  // Add to front
  cmdHistory.unshift(text);
  if (cmdHistory.length > MAX_CMD_HISTORY) cmdHistory.length = MAX_CMD_HISTORY;
  saveCmdHistory();
}

// UX Polish: Agent order persistence for drag reorder
const AGENT_ORDER_KEY = 'nexus-agent-order';

function loadAgentOrder() {
  try {
    const stored = localStorage.getItem(AGENT_ORDER_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return [];
}

function saveAgentOrder(orderArray) {
  try {
    localStorage.setItem(AGENT_ORDER_KEY, JSON.stringify(orderArray));
  } catch {}
}

// Cycle 3: Resizable panels
let sidebarWidth = parseInt(localStorage.getItem('nexus-sidebar-width')) || 280;
let previewWidth = parseInt(localStorage.getItem('nexus-preview-width')) || 320;
let isDragging = false;
let dragTarget = null;
let dragStartX = 0;
let dragStartWidth = 0;

// Cycle 3: Sound mute
let soundMuted = localStorage.getItem('claude-nexus-muted') === '1';

// Cycle 3: Context menu
let contextMenuAgentId = null;

// Cycle 3: Shortcut overlay
let shortcutOverlayVisible = false;

// Cycle 4: Command palette
let commandPaletteVisible = false;

// MCP Server Manager
let mcpManagerVisible = false;

// Focus / Zen Mode
let focusModeActive = false;

// Cycle 4: Auto-reply rules
let autoReplyGlobal = localStorage.getItem('nexus-auto-reply-global') === '1';
const autoReplyAgents = new Set(JSON.parse(localStorage.getItem('nexus-auto-reply-agents') || '[]'));

// Cycle 4: New lines indicator
// Tracks the scrollback length at the time user last viewed each agent
const lastViewedLines = new Map();

// Cycle 4: Status bar filter
let statusFilter = null; // null = show all, 'active' | 'waiting' | 'exited'

// Cycle 5: Snippets
const SNIPPETS_KEY = 'nexus-snippets';
const DEFAULT_SNIPPETS = [
  { name: 'Commit', text: 'commit your changes' },
  { name: 'Summarize', text: 'summarize what you did' },
  { name: 'Run Tests', text: 'run the tests' },
  { name: 'Stop', text: 'stop what you\'re doing' },
  { name: 'Continue', text: 'continue' },
];

function getSnippets() {
  try {
    const stored = localStorage.getItem(SNIPPETS_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return [...DEFAULT_SNIPPETS];
}

function saveSnippets(snippets) {
  localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets));
  // ITEM 2: Re-render quick action buttons when snippets change
  renderQuickActions();
}

// Cycle 5: Multi-select agents
let multiSelectedAgentIds = new Set();
let isMultiSelectMode = false;

// Cycle 5: Auto-save workspace timer
let autoSaveInterval = null;

// Cycle 6: Agent progress/cost tracker
let elapsedTimerInterval = null;

// File split preview state
let fileSplitVisible = false;
let fileSplitHeight = 240;
let fileSplitDragging = false;
let fileSplitDragStartY = 0;
let fileSplitDragStartHeight = 0;

// Session timer state (ITEM 4)
let sessionStartTime = null;
let sessionTimerInterval = null;

// Agent output activity tracking for heartbeat (ITEM 4)
let lastGlobalOutputTime = 0;

// Cycle 6: Connection quality
let lastPingTime = 0;
let latencyMs = 0;
let reconnectCount = 0;
let pingInterval = null;

// Cycle 7: Sticky notes (persisted in localStorage)
const NOTES_KEY = 'nexus-agent-notes';

function getAgentNotes() {
  try { return JSON.parse(localStorage.getItem(NOTES_KEY)) || {}; } catch { return {}; }
}

function saveAgentNote(agentId, note) {
  const notes = getAgentNotes();
  if (note) {
    notes[agentId] = note;
  } else {
    delete notes[agentId];
  }
  localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
}

// Cycle 7: Favicon badge + tab title rotation
let faviconBadgeActive = false;
let tabTitleRotationInterval = null;
let tabTitleRotationIndex = 0;
const ORIGINAL_FAVICON = document.querySelector('link[rel="icon"]')?.href || '';

// Cycle 7: Scroll-to-bottom tracking per agent
const agentScrolledUp = new Map();

// Preemptive UX: Last line preview per agent
const agentLastLine = new Map();

// Preemptive UX: Smart notification status per agent ('active' | 'error' | 'complete' | 'idle')
const agentSmartStatus = new Map();

// Preemptive UX: "What Did I Miss?" away tracking
let tabHiddenSince = null;
const awayOutputTracker = new Map(); // agentId -> { lineCount: number, lastLines: string[] }

// Preemptive UX: Agent hover popover
let hoverPopoverTimer = null;
let hoverPopoverAgentId = null;

// Preemptive UX: Startup prompt localStorage key
const STARTUP_PROMPT_KEY = 'nexus-last-startup-prompt';

// Cycle 7: Interval registry for cleanup
const _intervals = new Set();

// Cycle 6: Agent health pulse (last output timestamps)
const agentLastOutputTime = new Map();

// Cycle 6: Server disconnected banner
let disconnectedBannerVisible = false;

// ═══════════════════════════════════════════
// DOM helpers
// ═══════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clientStripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[\?[0-9;]*[hl]/g, '')
    .replace(/\x1B[()][AB012]/g, '')
    .replace(/\x1B[78DEHM=><]/g, '')
    .replace(/\x1B\[[\d;]*m/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function shortenPath(p) {
  // macOS: /Users/chris/... -> ~/...
  const macMatch = p.match(/^\/Users\/[^/]+/);
  if (macMatch) return p.replace(macMatch[0], '~');
  // Windows: C:\Users\chris\... -> ~\...
  const winMatch = p.match(/^[A-Z]:\\Users\\[^\\]+/i);
  if (winMatch) return p.replace(winMatch[0], '~');
  return p;
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function formatElapsed(startMs) {
  const diff = Math.floor((Date.now() - startMs) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function showToast(message, type = 'info') {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function showConfirmDialog(message, onConfirm) {
  const overlay = $('#confirm-overlay');
  const msgEl = $('#confirm-message');
  const cancelBtn = $('#confirm-cancel');
  const okBtn = $('#confirm-ok');

  msgEl.textContent = message;
  overlay.classList.remove('hidden');

  // Remove old listeners by cloning
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
  const newOk = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);

  const close = () => overlay.classList.add('hidden');

  newCancel.addEventListener('click', close);
  newOk.addEventListener('click', () => { close(); onConfirm(); });

  // Also close on overlay click
  const onOverlayClick = (e) => {
    if (e.target === overlay) {
      close();
      overlay.removeEventListener('click', onOverlayClick);
    }
  };
  overlay.addEventListener('click', onOverlayClick);

  // Focus the confirm button
  setTimeout(() => newOk.focus(), 50);
}

// ═══════════════════════════════════════════
// Notification Sound
// ═══════════════════════════════════════════

function playNotificationSound() {
  playSound('question');
}

function playSound(type) {
  if (soundMuted) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    switch (type) {
      case 'question': {
        // Soft ping (existing behavior): 660Hz, 0.25s
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 660;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.06, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        osc.start();
        osc.stop(t + 0.25);
        break;
      }

      case 'sent': {
        // Very subtle click: 1200Hz, 0.05s, very quiet
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 1200;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.03, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        osc.start();
        osc.stop(t + 0.05);
        break;
      }

      case 'complete': {
        // Pleasant two-tone chime: 880Hz then 1100Hz, 0.15s each
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.frequency.value = 880;
        osc1.type = 'sine';
        gain1.gain.setValueAtTime(0.05, t);
        gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        osc1.start(t);
        osc1.stop(t + 0.15);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.value = 1100;
        osc2.type = 'sine';
        gain2.gain.setValueAtTime(0.05, t + 0.15);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.30);
        osc2.start(t + 0.15);
        osc2.stop(t + 0.30);
        break;
      }

      case 'error': {
        // Low alert tone: 330Hz, 0.3s
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 330;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.05, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        osc.start();
        osc.stop(t + 0.3);
        break;
      }

      case 'exited': {
        // Descending tone: 550Hz dropping to 330Hz, 0.2s
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(550, t);
        osc.frequency.linearRampToValueAtTime(330, t + 0.2);
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.04, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        osc.start();
        osc.stop(t + 0.2);
        break;
      }

      default: {
        // Fallback to question ping
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 660;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.06, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        osc.start();
        osc.stop(t + 0.25);
      }
    }
  } catch {}
}

function toggleMute() {
  soundMuted = !soundMuted;
  localStorage.setItem('claude-nexus-muted', soundMuted ? '1' : '0');
  updateMuteUI();
  showToast(soundMuted ? 'Notifications muted' : 'Notifications unmuted', 'info');
}

function updateMuteUI() {
  const btn = $('#btn-mute-toggle');
  const iconOn = $('#mute-icon-on');
  const iconOff = $('#mute-icon-off');
  if (!btn) return;
  if (soundMuted) {
    btn.classList.add('muted');
    iconOn.classList.add('hidden');
    iconOff.classList.remove('hidden');
  } else {
    btn.classList.remove('muted');
    iconOn.classList.remove('hidden');
    iconOff.classList.add('hidden');
  }
}

// ═══════════════════════════════════════════
// Activity Log
// ═══════════════════════════════════════════

function addActivity(icon, text, type = 'info') {
  activityLog.unshift({
    icon,
    text,
    type,
    timestamp: Date.now(),
  });
  if (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog.length = MAX_ACTIVITY_LOG;
  }
  renderActivityLog();
}

function renderActivityLog() {
  const log = $('#activity-log');
  const noActivity = $('#no-activity');
  const badge = $('#activity-count');
  if (!log) return;

  if (activityLog.length === 0) {
    log.innerHTML = '';
    if (noActivity) noActivity.classList.remove('hidden');
    if (badge) badge.classList.add('hidden');
    return;
  }

  if (noActivity) noActivity.classList.add('hidden');
  if (badge) {
    badge.textContent = activityLog.length;
    badge.classList.remove('hidden');
  }

  log.innerHTML = activityLog.slice(0, 100).map(entry => {
    const time = formatTime(entry.timestamp);
    return `<div class="activity-entry activity-${entry.type}">
      <span class="activity-icon">${entry.icon}</span>
      <span class="activity-text">${escapeHtml(entry.text)}</span>
      <span class="activity-time">${time}</span>
    </div>`;
  }).join('');
}

function formatTime(ts) {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ═══════════════════════════════════════════
// Recent directories (persisted in localStorage)
// ═══════════════════════════════════════════

function getRecentDirs() {
  try { return JSON.parse(localStorage.getItem(RECENT_DIRS_KEY)) || []; } catch { return []; }
}

function saveRecentDir(dir) {
  const dirs = getRecentDirs().filter(d => d !== dir);
  dirs.unshift(dir);
  if (dirs.length > MAX_RECENT_DIRS) dirs.length = MAX_RECENT_DIRS;
  try { localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs)); } catch {}
}

// ═══════════════════════════════════════════
// WebSocket Connection
// ═══════════════════════════════════════════

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    updateConnectionIndicator('connected', 0);
    hideDisconnectedBanner();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      showToast('Reconnected', 'success');
    }
    // Start ping interval for latency measurement
    if (pingInterval) { clearInterval(pingInterval); _intervals.delete(pingInterval); }
    pingInterval = setInterval(sendPing, 5000);
    _intervals.add(pingInterval);
    sendPing();
  };

  ws.onmessage = (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (err) {
      console.error('Message parse error:', err);
    }
  };

  ws.onclose = () => {
    updateConnectionIndicator('disconnected', 0);
    if (pingInterval) { clearInterval(pingInterval); _intervals.delete(pingInterval); pingInterval = null; }
    reconnectCount++;
    showDisconnectedBanner();
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {};
}

function sendPing() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    lastPingTime = performance.now();
    ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
  }
}

function handlePong() {
  latencyMs = Math.round(performance.now() - lastPingTime);
  updateConnectionIndicator('connected', latencyMs);
}

function updateConnectionIndicator(state, latency) {
  const el = $('#connection-status');
  if (!el) return;

  el.classList.remove('connected', 'conn-green', 'conn-yellow', 'conn-red');
  if (state === 'connected') {
    el.classList.add('connected');
    if (latency < 100) {
      el.classList.add('conn-green');
      el.title = `Connected (${latency}ms)`;
    } else if (latency < 500) {
      el.classList.add('conn-yellow');
      el.title = `Slow connection (${latency}ms)`;
    } else {
      el.classList.add('conn-red');
      el.title = `High latency (${latency}ms)`;
    }
    if (reconnectCount > 0) {
      el.title += ` | Reconnected ${reconnectCount}x`;
    }
  } else {
    el.title = `Disconnected${reconnectCount > 0 ? ` (reconnected ${reconnectCount}x)` : ''}`;
  }

  // Update latency text display
  const latencyEl = $('#connection-latency');
  if (latencyEl) {
    if (state === 'connected' && latency > 0) {
      latencyEl.textContent = `${latency}ms`;
      latencyEl.classList.remove('hidden');
    } else {
      latencyEl.classList.add('hidden');
    }
  }
}

function showDisconnectedBanner() {
  if (disconnectedBannerVisible) return;
  disconnectedBannerVisible = true;
  const container = $('#terminal-container');
  if (!container) return;

  let banner = $('#disconnected-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'disconnected-banner';
    banner.className = 'disconnected-banner';
    banner.innerHTML = '<span class="disconnected-icon">&#x26A0;</span> Server disconnected. Attempting to reconnect...';
    container.appendChild(banner);
  }
  banner.classList.remove('hidden');
}

function hideDisconnectedBanner() {
  disconnectedBannerVisible = false;
  const banner = $('#disconnected-banner');
  if (banner) banner.classList.add('hidden');
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ═══════════════════════════════════════════
// Message Router
// ═══════════════════════════════════════════

function handleMessage(msg) {
  switch (msg.type) {
    case 'created':          onAgentCreated(msg);       break;
    case 'output':           onTerminalOutput(msg);     break;
    case 'question':         onQuestion(msg);           break;
    case 'questionResolved': onQuestionResolved(msg);   break;
    case 'status':           onStatusChange(msg);       break;
    case 'exited':           onAgentExited(msg);        break;
    case 'destroyed':        onAgentDestroyed(msg);     break;
    case 'files':            renderFileBrowser(msg);    break;
    case 'fileContent':      renderFileContent(msg);    break;
    case 'pong':             handlePong();              break;
    case 'lastLine':         onLastLine(msg);           break;
    case 'smartStatus':      onSmartStatus(msg);        break;
    case 'tunnel':           handleTunnelMessage(msg); break;
    case 'error':            showToast(msg.message, 'error'); break;
  }
}

// ═══════════════════════════════════════════
// Agent Lifecycle
// ═══════════════════════════════════════════

function onAgentCreated(msg) {
  const { id, name, cwd, command, status, question } = msg;

  // Reconnect: just update state, don't recreate terminal
  if (agents.has(id)) {
    const existing = agents.get(id);
    existing.status = status || 'active';
    if (msg.startedAt) existing.startedAt = msg.startedAt;
    if (msg.lastOutput) agentLastOutputTime.set(id, msg.lastOutput);
    if (question) {
      existing.question = question;
      existing.questionTime = Date.now();
    }
    renderSidebar();
    return;
  }

  // Create xterm instance
  const terminal = new Terminal({
    cursorBlink: false,
    cursorStyle: 'underline',
    cursorWidth: 0,
    cursorInactiveStyle: 'none',
    fontSize: 15,
    fontFamily: "'Source Code Pro', 'JetBrains Mono', 'Fira Code', Menlo, monospace",
    fontWeight: 400,
    fontWeightBold: 700,
    lineHeight: 1.7,
    letterSpacing: 0.5,
    theme: TERMINAL_THEME,
    scrollback: 5000,
    allowProposedApi: true,
    fastScrollModifier: 'alt',
    fastScrollSensitivity: 10,
    scrollSensitivity: 3,
    disableStdin: false,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);

  try {
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(webLinksAddon);
  } catch {}

  // Create DOM container
  const container = document.createElement('div');
  container.className = 'terminal-instance';
  container.id = `term-${id}`;
  container.style.display = 'none';
  $('#terminal-container').appendChild(container);

  terminal.open(container);

  // Force xterm to re-measure after web fonts load.
  // xterm.js measures the character grid on open() using whatever font is
  // available at that moment (usually a fallback). We need to re-assign
  // fontFamily AND fontSize after fonts load to force a full re-measure.
  const FONT = "'Source Code Pro', 'JetBrains Mono', 'Fira Code', Menlo, monospace";
  const forceRefont = () => {
    terminal.options.fontSize = 15;
    terminal.options.fontFamily = FONT;
    terminal.options.lineHeight = 1.7;
    terminal.options.letterSpacing = 0.5;
    try { fitAddon.fit(); } catch {}
  };
  // Try immediately (fonts may be cached)
  setTimeout(forceRefont, 100);
  // Also try after all fonts load
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => setTimeout(forceRefont, 50));
  }
  // And once more as a safety net
  setTimeout(forceRefont, 2000);

  // Only forward control sequences (Ctrl+C, Ctrl+D, arrow keys, etc.)
  // All text input goes through the floating input bar
  terminal.onData((data) => {
    const code = data.charCodeAt(0);
    // Allow: Ctrl keys (codes 1-26), Escape (27), arrow/function keys (start with \x1b[)
    if (code <= 26 || code === 27 || data.startsWith('\x1b[') || data.startsWith('\x1b0')) {
      // Ctrl+C (code 3): if there is selected text, copy to clipboard instead of sending interrupt
      if (code === 3 && terminal.hasSelection()) {
        const selectedText = terminal.getSelection();
        if (selectedText) {
          navigator.clipboard.writeText(selectedText).then(() => {
            showToast('Copied to clipboard', 'info');
          }).catch(() => {});
          terminal.clearSelection();
          return; // Don't send Ctrl+C to PTY
        }
      }
      send({ type: 'input', id, data });
    }
    // Block regular text input; it goes through the floating bar instead
  });

  // Track terminal selection changes to show/hide Copy button
  terminal.onSelectionChange(() => {
    const copyBtn = $('#btn-copy-selection');
    if (copyBtn && id === activeAgentId) {
      if (terminal.hasSelection()) {
        copyBtn.style.display = '';
      } else {
        copyBtn.style.display = 'none';
      }
    }
  });

  // Store agent state
  const agent = {
    id, name, cwd, command: command || 'claude', terminal, fitAddon, searchAddon, container,
    status: status || 'active',
    question: question || null,
    questionTime: question ? Date.now() : null,
    hasUnread: false,   // true when output arrives while this agent isn't focused
    pinned: false,      // Cycle 3: pin to top of agent list
    colorLabel: null,   // Cycle 3: custom color label (null = default)
    startedAt: msg.startedAt || Date.now(),
  };
  agents.set(id, agent);
  agentLastOutputTime.set(id, msg.lastOutput || Date.now());

  // Preemptive UX: Initialize last line and smart status from server sync
  if (msg.lastLine) agentLastLine.set(id, msg.lastLine);
  if (msg.smartStatus) agentSmartStatus.set(id, msg.smartStatus);

  // Cycle 4: Initialize line tracking
  lastViewedLines.set(id, 0);

  // Cycle 6: Terminal welcome message (only for genuinely new agents, not session replays)
  const isNewAgent = !msg.question && (!msg.startedAt || (Date.now() - msg.startedAt) < 5000);
  if (isNewAgent) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    terminal.write(
      '\x1b[38;5;99m\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\x1b[0m\r\n' +
      '\x1b[38;5;99m\u2502\x1b[0m \x1b[1;38;5;141m\u25C6 Claude Nexus\x1b[0m\r\n' +
      '\x1b[38;5;99m\u2502\x1b[0m\r\n' +
      '\x1b[38;5;99m\u2502\x1b[0m \x1b[38;5;248mAgent:\x1b[0m  \x1b[1m' + name + '\x1b[0m\r\n' +
      '\x1b[38;5;99m\u2502\x1b[0m \x1b[38;5;248mDir:\x1b[0m    \x1b[38;5;75m' + cwd + '\x1b[0m\r\n' +
      '\x1b[38;5;99m\u2502\x1b[0m \x1b[38;5;248mTime:\x1b[0m   \x1b[38;5;248m' + dateStr + ' ' + timeStr + '\x1b[0m\r\n' +
      '\x1b[38;5;99m\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\x1b[0m\r\n\r\n'
    );
  }

  // Remove loading placeholder
  removePendingPlaceholder();

  // Auto-switch to the newly created agent
  switchToAgent(id);
  renderSidebar();
  renderStatusBar();
  addActivity('\u25B6', `Agent "${name}" created`, 'success');

  // Cycle 5: Auto-save workspace when agents change
  autoSaveCurrentWorkspace();
}

function onTerminalOutput(msg) {
  const agent = agents.get(msg.id);
  if (!agent) return;
  agent.terminal.write(msg.data);

  // Cycle 6: Track last output time for health pulse
  agentLastOutputTime.set(msg.id, Date.now());

  // ITEM 4: Track global output time for heartbeat
  lastGlobalOutputTime = Date.now();

  // Cycle 6: Flash sidebar entry on output (Item 3)
  flashAgentSidebarEntry(msg.id);

  // Cycle 4: Track output line count
  if (!agent._lineCount) agent._lineCount = 0;
  // Count newlines in the output chunk
  const newLines = (msg.data.match(/\n/g) || []).length;
  agent._lineCount += Math.max(newLines, 1);

  // Preemptive UX: Track output while tab is hidden (away summary)
  if (tabHiddenSince !== null) {
    if (!awayOutputTracker.has(msg.id)) {
      awayOutputTracker.set(msg.id, { lineCount: 0, lastLines: [] });
    }
    const tracker = awayOutputTracker.get(msg.id);
    tracker.lineCount += Math.max(newLines, 1);
    // Keep last lines (ANSI-stripped)
    const cleanLines = clientStripAnsi(msg.data).split('\n').filter(l => l.trim());
    for (const line of cleanLines) {
      tracker.lastLines.push(line.trim().substring(0, 100));
      if (tracker.lastLines.length > 3) tracker.lastLines.shift();
    }
  }

  // Mark unread if this isn't the active agent
  if (msg.id !== activeAgentId) {
    agent.hasUnread = true;
    renderSidebar();
  }

  // Cycle 7: Update scroll-to-bottom button visibility on new output
  if (msg.id === activeAgentId) {
    updateScrollToBottomButton(agent);
  }
}

// Cycle 6: Flash sidebar entry briefly on output
function flashAgentSidebarEntry(agentId) {
  const el = document.querySelector(`.agent-item[data-agent-id="${agentId}"]`);
  if (!el || el.classList.contains('agent-flash')) return;
  el.classList.add('agent-flash');
  setTimeout(() => el.classList.remove('agent-flash'), 600);
}

function onQuestion(msg) {
  const agent = agents.get(msg.id);
  if (agent) {
    agent.status = 'waiting';
    agent.question = msg.text;
    agent.questionTime = msg.timestamp || Date.now();
  }

  // Cycle 4: Auto-reply check (global or per-agent)
  // Claude Code uses two prompt styles:
  //   1. Selection menus (> Yes / No) where Enter confirms the default (Yes)
  //   2. Text prompts (y/n) where typing "y" + Enter works
  // Strategy: send Enter first (covers selection menus), then "y\r" after
  // a short delay as fallback (covers text prompts). This handles both.
  if (autoReplyGlobal || autoReplyAgents.has(msg.id)) {
    send({ type: 'input', id: msg.id, data: '\r' });
    setTimeout(() => {
      send({ type: 'input', id: msg.id, data: 'y\r' });
    }, 150);
    addActivity('\u2713', `Auto-replied to ${msg.name}`, 'success');
    return;
  }

  renderSidebar();
  renderStatusBar();
  addActivity('\u2753', `${msg.name} asked a question`, 'warning');

  // Auto-focus the question input if this is the active agent (ITEM 5)
  if (msg.id === activeAgentId) {
    // Use a short delay to let the RAF-debounced sidebar render finish
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const input = $(`#question-list .question-input[data-agent-id="${msg.id}"]`);
        if (input) input.focus();
      });
    });
  }

  // Desktop notification when tab is hidden
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`${msg.name} needs input`, {
        body: msg.text.substring(0, 120),
        tag: msg.id,
      });
    } catch {}
  }

  // Subtle audio ping (respects mute setting)
  playNotificationSound();
}

function onQuestionResolved(msg) {
  const agent = agents.get(msg.id);
  const agentName = agent ? agent.name : msg.id;
  if (agent) {
    agent.status = 'active';
    agent.question = null;
    agent.questionTime = null;
  }
  renderSidebar();
  renderStatusBar();
  addActivity('\u2713', `${agentName} question answered`, 'success');
}

function onStatusChange(msg) {
  const agent = agents.get(msg.id);
  if (agent) agent.status = msg.status;
  renderSidebar();
  renderStatusBar();
  // Also update terminal header + floating input if this is the active agent
  if (msg.id === activeAgentId) {
    updateTerminalHeader(agent);
    showFloatingInput(agent);
  }
}

function onAgentExited(msg) {
  const agent = agents.get(msg.id);
  const agentName = agent ? agent.name : msg.id;
  if (agent) {
    agent.status = 'exited';
    agent.terminal.write('\r\n\x1b[38;5;240m--- Session ended (exit ' + (msg.code || 0) + ') ---\x1b[0m\r\n');
  }
  if (msg.id === activeAgentId) hideFloatingInput();
  renderSidebar();
  renderStatusBar();
  addActivity('\u23F9', `${agentName} exited (code ${msg.code || 0})`, 'error');
  playSound('exited');
}

function onAgentDestroyed(msg) {
  const agent = agents.get(msg.id);
  if (!agent) return;

  agent.terminal.dispose();
  agent.container.remove();
  agents.delete(msg.id);
  agentLastOutputTime.delete(msg.id);
  agentLastLine.delete(msg.id);
  agentSmartStatus.delete(msg.id);

  // Check for pending restart (ITEM 3 race condition fix)
  const restart = pendingRestarts.get(msg.id);
  if (restart) {
    pendingRestarts.delete(msg.id);
    send({ type: 'create', name: restart.name, cwd: restart.cwd, command: restart.command });
  }

  // Cycle 5: Remove from multi-select if present
  multiSelectedAgentIds.delete(msg.id);
  if (multiSelectedAgentIds.size <= 1) {
    isMultiSelectMode = false;
    multiSelectedAgentIds.clear();
  }

  if (activeAgentId === msg.id) {
    activeAgentId = null;
    const remaining = Array.from(agents.keys());
    if (remaining.length > 0) {
      switchToAgent(remaining[remaining.length - 1]);
    } else {
      showEmptyState();
    }
  }
  renderSidebar();
  renderStatusBar();
  updateFloatingInputMultiMode();

  // Cycle 5: Auto-save workspace when agents change
  autoSaveCurrentWorkspace();
}

// ═══════════════════════════════════════════
// Agent Switching
// ═══════════════════════════════════════════

function switchToAgent(id) {
  const agent = agents.get(id);
  if (!agent) return;

  // Cycle 4: Calculate new lines since last view and show indicator
  const prevViewed = lastViewedLines.get(id) || 0;
  const currentLines = agent._lineCount || 0;
  const newLinesSinceViewed = currentLines - prevViewed;

  // Smooth fade transition when switching agents
  const prevAgentId = activeAgentId;
  const prevAgent = prevAgentId ? agents.get(prevAgentId) : null;

  // Hide all non-active, non-target terminals immediately
  for (const a of agents.values()) {
    if (a.id !== id && a.id !== prevAgentId) {
      a.container.style.display = 'none';
      a.container.classList.remove('term-fade-in', 'term-fade-out');
    }
  }

  // Fade out previous, fade in new
  if (prevAgent && prevAgent.id !== id) {
    prevAgent.container.classList.add('term-fade-out');
    setTimeout(() => {
      prevAgent.container.style.display = 'none';
      prevAgent.container.classList.remove('term-fade-out');
    }, 120);
  }

  // Show the new terminal with fade in
  agent.container.style.display = 'block';
  agent.container.classList.add('term-fade-in');
  setTimeout(() => {
    agent.container.classList.remove('term-fade-in');
  }, 120);

  activeAgentId = id;

  // Clear unread for this agent
  agent.hasUnread = false;

  // Hide empty state
  const emptyState = $('#empty-state');
  if (emptyState) emptyState.style.display = 'none';

  // Update terminal header
  $('#terminal-header').classList.remove('hidden');
  updateTerminalHeader(agent);

  // Hide copy selection button (reset for new agent)
  const copySelBtn = $('#btn-copy-selection');
  if (copySelBtn) copySelBtn.style.display = 'none';

  // Close agent switcher if open
  closeAgentSwitcher();

  // (new-lines indicator removed: was too noisy)
  hideNewLinesIndicator();

  // Cycle 4: Record current line count as "last viewed"
  lastViewedLines.set(id, currentLines);

  // Show floating input
  showFloatingInput(agent);

  // Fit and focus terminal
  requestAnimationFrame(() => {
    try {
      agent.fitAddon.fit();
      agent.terminal.focus();
      send({ type: 'resize', id, cols: agent.terminal.cols, rows: agent.terminal.rows });
    } catch {}

    // Cycle 7: Attach scroll listener and update scroll-to-bottom button
    const viewport = agent.container.querySelector('.xterm-viewport');
    if (viewport && !viewport._nexusScrollBound) {
      viewport._nexusScrollBound = true;
      viewport.addEventListener('scroll', () => {
        updateScrollToBottomButton(agent);
      }, { passive: true });
    }
    updateScrollToBottomButton(agent);
  });

  // Close file split when switching agents (file is from different context)
  if (fileSplitVisible) {
    closeFileSplit();
  }

  // Refresh file browser if open
  if (previewVisible) {
    previewHistory = [];
    browseFiles(agent.cwd);
  }

  renderSidebar();
}

function updateTerminalHeader(agent) {
  if (!agent) return;
  $('#terminal-agent-name').textContent = agent.name;
  $('#terminal-agent-cwd').textContent = shortenPath(agent.cwd);

  const dot = $('#terminal-status-dot');
  dot.className = 'terminal-status-dot';
  if (agent.status === 'active')       dot.style.background = 'var(--color-success)';
  else if (agent.status === 'waiting') dot.style.background = 'var(--color-warning)';
  else                                 dot.style.background = 'var(--color-text-tertiary)';

  // Cycle 6: Session timer in header
  const timerEl = $('#terminal-session-timer');
  if (timerEl && agent.startedAt) {
    timerEl.textContent = formatElapsed(agent.startedAt);
    timerEl.classList.remove('hidden');
  } else if (timerEl) {
    timerEl.classList.add('hidden');
  }
}

function showEmptyState() {
  $('#terminal-header').classList.add('hidden');
  hideFloatingInput();
  for (const a of agents.values()) a.container.style.display = 'none';
  const es = $('#empty-state');
  if (es) es.style.display = '';
}

// ═══════════════════════════════════════════
// Floating Input Bar
// ═══════════════════════════════════════════

function showFloatingInput(agent) {
  if (agent && agent.status === 'exited') { hideFloatingInput(); return; }
  const bar = $('#floating-input');
  const container = $('#terminal-container');
  if (!bar || !agent) return;

  bar.classList.remove('hidden');
  container.classList.add('has-floating-input');
  $('#floating-input-agent-name').textContent = agent.name;

  // Reset textarea height when showing
  const textarea = $('#floating-input-field');
  if (textarea) autoResizeTextarea(textarea);

  // Update status dot color
  const dot = bar.querySelector('.floating-input-dot');
  if (dot) {
    if (agent.status === 'waiting') {
      dot.style.background = 'var(--color-warning)';
      dot.style.boxShadow = '0 0 6px var(--color-warning-glow)';
    } else {
      dot.style.background = 'var(--color-success)';
      dot.style.boxShadow = '0 0 6px var(--color-success-glow)';
    }
  }
}

function hideFloatingInput() {
  const bar = $('#floating-input');
  const container = $('#terminal-container');
  if (bar) bar.classList.add('hidden');
  if (container) container.classList.remove('has-floating-input');
}

function sendFloatingInput() {
  const input = $('#floating-input-field');
  if (!input) return;
  const text = input.value;
  if (!text) return;

  // Add to command history
  addToHistory(text);
  cmdHistoryIndex = -1;
  cmdHistoryDraft = '';

  // Dismiss autocomplete if visible
  closeAutocomplete();

  // Cycle 5: If multi-select mode, send to all selected agents
  if (isMultiSelectMode && multiSelectedAgentIds.size > 1) {
    sendMultiInput();
    return;
  }

  if (!activeAgentId) return;
  // Send text + carriage return (Enter). PTYs expect \r not \n.
  send({ type: 'input', id: activeAgentId, data: text + '\r' });
  input.value = '';
  // Reset textarea height after sending
  autoResizeTextarea(input);

  // Sound feedback: message sent
  playSound('sent');

  // Refocus terminal after sending
  const agent = agents.get(activeAgentId);
  if (agent) agent.terminal.focus();
}

// ═══════════════════════════════════════════
// Cycle 5: Snippets System
// ═══════════════════════════════════════════

let snippetsDropdownVisible = false;

function toggleSnippetsDropdown() {
  if (snippetsDropdownVisible) {
    closeSnippetsDropdown();
  } else {
    openSnippetsDropdown();
  }
}

function openSnippetsDropdown() {
  closeSnippetsDropdown();
  snippetsDropdownVisible = true;

  const snippets = getSnippets();
  const bar = $('#floating-input');
  if (!bar) return;

  const dropdown = document.createElement('div');
  dropdown.id = 'snippets-dropdown';
  dropdown.className = 'snippets-dropdown';

  let html = '<div class="snippets-header">Quick Prompts</div>';
  if (snippets.length === 0) {
    html += '<div class="snippets-empty">No snippets saved</div>';
  } else {
    for (let i = 0; i < snippets.length; i++) {
      html += `<div class="snippets-item" data-index="${i}">
        <span class="snippets-item-text">${escapeHtml(snippets[i].text)}</span>
        <button class="snippets-item-delete btn btn-icon-only btn-small" data-index="${i}" title="Remove snippet">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
        </button>
      </div>`;
    }
  }
  html += '<div class="snippets-divider"></div>';
  html += '<div class="snippets-item snippets-add-new"><span class="snippets-item-text">+ Add current text as snippet</span></div>';

  dropdown.innerHTML = html;
  bar.querySelector('.floating-input-inner').appendChild(dropdown);

  // Bind click handlers
  for (const item of dropdown.querySelectorAll('.snippets-item[data-index]')) {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.snippets-item-delete')) return;
      const idx = parseInt(item.dataset.index);
      const snippet = snippets[idx];
      if (snippet) {
        const input = $('#floating-input-field');
        if (input) {
          input.value = snippet.text;
          autoResizeTextarea(input);
          input.focus();
        }
      }
      closeSnippetsDropdown();
    });
  }

  // Delete buttons
  for (const delBtn of dropdown.querySelectorAll('.snippets-item-delete')) {
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(delBtn.dataset.index);
      snippets.splice(idx, 1);
      saveSnippets(snippets);
      closeSnippetsDropdown();
      openSnippetsDropdown();
      showToast('Snippet removed', 'info');
    });
  }

  // Add new snippet
  const addNew = dropdown.querySelector('.snippets-add-new');
  if (addNew) {
    addNew.addEventListener('click', () => {
      const input = $('#floating-input-field');
      const text = input ? input.value.trim() : '';
      if (!text) {
        showToast('Type a message first, then save as snippet', 'info');
        closeSnippetsDropdown();
        return;
      }
      snippets.push({ name: text.substring(0, 30), text });
      saveSnippets(snippets);
      showToast('Snippet saved', 'success');
      closeSnippetsDropdown();
    });
  }

  // Close on outside click
  const closeHandler = (e) => {
    if (!dropdown.contains(e.target) && !e.target.closest('#btn-snippets')) {
      closeSnippetsDropdown();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

function closeSnippetsDropdown() {
  snippetsDropdownVisible = false;
  const dropdown = $('#snippets-dropdown');
  if (dropdown) dropdown.remove();
}

function addSnippetFromInput() {
  const input = $('#floating-input-field');
  const text = input ? input.value.trim() : '';
  if (!text) {
    showToast('Type a message first, then save as snippet', 'info');
    return;
  }
  const snippets = getSnippets();
  snippets.push({ name: text.substring(0, 30), text });
  saveSnippets(snippets);
  showToast('Snippet saved', 'success');
}

// ═══════════════════════════════════════════
// UX Polish: Autocomplete from command history
// ═══════════════════════════════════════════

function showAutocomplete(query) {
  closeAutocomplete();
  if (!query || query.length < 1 || cmdHistory.length === 0) return;

  const lowerQuery = query.toLowerCase();
  // Filter history entries that contain the query (case-insensitive)
  const matches = cmdHistory.filter(item =>
    item.toLowerCase().includes(lowerQuery) && item !== query
  ).slice(0, 5);

  if (matches.length === 0) return;

  const bar = $('#floating-input');
  if (!bar) return;

  const dropdown = document.createElement('div');
  dropdown.id = 'autocomplete-dropdown';
  dropdown.className = 'autocomplete-dropdown';

  for (let i = 0; i < matches.length; i++) {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.dataset.text = matches[i];
    // Highlight the matched portion
    const matchIdx = matches[i].toLowerCase().indexOf(lowerQuery);
    if (matchIdx >= 0) {
      const before = escapeHtml(matches[i].substring(0, matchIdx));
      const matched = escapeHtml(matches[i].substring(matchIdx, matchIdx + query.length));
      const after = escapeHtml(matches[i].substring(matchIdx + query.length));
      item.innerHTML = `${before}<strong>${matched}</strong>${after}`;
    } else {
      item.textContent = matches[i];
    }
    item.addEventListener('mousedown', (e) => {
      e.preventDefault(); // Don't blur the input
      const input = $('#floating-input-field');
      if (input) {
        input.value = matches[i];
        autoResizeTextarea(input);
        input.focus();
      }
      closeAutocomplete();
    });
    dropdown.appendChild(item);
  }

  bar.querySelector('.floating-input-inner').appendChild(dropdown);
}

function closeAutocomplete() {
  const dropdown = $('#autocomplete-dropdown');
  if (dropdown) dropdown.remove();
}

function navigateAutocomplete(direction) {
  const dropdown = $('#autocomplete-dropdown');
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('.autocomplete-item');
  if (items.length === 0) return;

  let currentIdx = -1;
  items.forEach((item, i) => {
    if (item.classList.contains('highlighted')) currentIdx = i;
  });

  // Remove current highlight
  if (currentIdx >= 0) items[currentIdx].classList.remove('highlighted');

  let nextIdx = currentIdx + direction;
  if (nextIdx < 0) nextIdx = items.length - 1;
  if (nextIdx >= items.length) nextIdx = 0;

  items[nextIdx].classList.add('highlighted');
}

// ═══════════════════════════════════════════
// Cycle 5: Session Export to Markdown
// ═══════════════════════════════════════════

function exportAgentSession(agentId) {
  const agent = agents.get(agentId);
  if (!agent) {
    showToast('Agent not found', 'error');
    return;
  }

  const terminal = agent.terminal;
  const buffer = terminal.buffer.active;
  const lines = [];

  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }

  // Strip trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  const content = lines.join('\n');

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0];

  const markdown = `# Agent: ${agent.name}\n## Session: ${dateStr} ${timeStr}\n### Directory: ${agent.cwd}\n\n\`\`\`\n${content}\n\`\`\`\n`;

  // Trigger download
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${agent.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${dateStr}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`Session exported for "${agent.name}"`, 'success');
  addActivity('\u{1F4E4}', `Exported session for "${agent.name}"`, 'info');
}

// ═══════════════════════════════════════════
// Cycle 5: Auto-Launch Last Workspace
// ═══════════════════════════════════════════

function checkLastWorkspace() {
  const lastWorkspace = localStorage.getItem('nexus-last-workspace');
  if (!lastWorkspace) return;

  // Show restore toast
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast toast-restore';
  toast.innerHTML = `
    <span>Restore last session "${escapeHtml(lastWorkspace)}"?</span>
    <div class="toast-actions">
      <button class="btn btn-primary btn-small toast-yes">Yes</button>
      <button class="btn btn-ghost btn-small toast-no">No</button>
    </div>
  `;
  container.appendChild(toast);

  toast.querySelector('.toast-yes').addEventListener('click', () => {
    toast.remove();
    restoreLastWorkspace(lastWorkspace);
  });

  toast.querySelector('.toast-no').addEventListener('click', () => {
    toast.remove();
  });

  // Auto-dismiss after 10 seconds
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 250);
    }
  }, 10000);
}

function restoreLastWorkspace(name) {
  fetch('/api/workspaces')
    .then(r => {
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      return r.json();
    })
    .then(raw => {
      const workspaces = Array.isArray(raw) ? raw : (raw.workspaces || []);
      const ws = workspaces.find(w => w.name === name);
      if (ws) {
        loadWorkspace(name, workspaces);
      } else {
        showToast(`Workspace "${name}" not found`, 'error');
      }
    })
    .catch(err => showToast(`Restore error: ${err.message}`, 'error'));
}

function autoSaveCurrentWorkspace() {
  if (agents.size === 0) return;

  const agentList = [];
  for (const a of agents.values()) {
    agentList.push({ name: a.name, cwd: a.cwd, command: a.command || 'claude' });
  }

  fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '_lastSession', agents: agentList }),
  }).catch(() => {}); // Silent fail

  localStorage.setItem('nexus-last-workspace', '_lastSession');
}

function startAutoSave() {
  if (autoSaveInterval) { clearInterval(autoSaveInterval); _intervals.delete(autoSaveInterval); }
  autoSaveInterval = setInterval(() => {
    autoSaveCurrentWorkspace();
  }, 30000); // Every 30 seconds
  _intervals.add(autoSaveInterval);
}

// ═══════════════════════════════════════════
// Cycle 5: Multi-Select Agents
// ═══════════════════════════════════════════

function handleAgentClick(agentId, e) {
  const isMeta = e.metaKey || e.ctrlKey;

  if (isMeta) {
    // Toggle multi-select for this agent
    if (multiSelectedAgentIds.has(agentId)) {
      multiSelectedAgentIds.delete(agentId);
    } else {
      multiSelectedAgentIds.add(agentId);
    }
    // If only one remains and it's the current active, clear multi-select
    if (multiSelectedAgentIds.size === 0) {
      isMultiSelectMode = false;
    } else {
      isMultiSelectMode = true;
    }
    renderSidebar();
    updateFloatingInputMultiMode();
    return;
  }

  // Normal click: clear multi-select, switch to agent
  if (isMultiSelectMode) {
    multiSelectedAgentIds.clear();
    isMultiSelectMode = false;
    renderSidebar();
  }
  switchToAgent(agentId);
  updateFloatingInputMultiMode();
}

function selectAllAgents() {
  multiSelectedAgentIds.clear();
  for (const [id] of agents) {
    multiSelectedAgentIds.add(id);
  }
  isMultiSelectMode = multiSelectedAgentIds.size > 1;
  renderSidebar();
  updateFloatingInputMultiMode();
}

function updateFloatingInputMultiMode() {
  const label = $('#floating-input-agent-name');
  const input = $('#floating-input-field');
  if (!label || !input) return;

  if (isMultiSelectMode && multiSelectedAgentIds.size > 1) {
    label.textContent = `Send to ${multiSelectedAgentIds.size} agents`;
    input.placeholder = `Message ${multiSelectedAgentIds.size} agents...`;
    const dot = document.querySelector('.floating-input-dot');
    if (dot) {
      dot.style.background = 'var(--color-accent)';
      dot.style.boxShadow = '0 0 6px var(--color-accent-glow)';
    }
  } else if (activeAgentId) {
    const agent = agents.get(activeAgentId);
    if (agent) {
      label.textContent = agent.name;
      input.placeholder = 'Type a message to the agent...';
    }
  }
}

function sendMultiInput() {
  const input = $('#floating-input-field');
  if (!input) return;
  const text = input.value;
  if (!text) return;

  // Add to command history
  addToHistory(text);
  cmdHistoryIndex = -1;
  cmdHistoryDraft = '';
  closeAutocomplete();

  let sent = 0;
  for (const id of multiSelectedAgentIds) {
    const agent = agents.get(id);
    if (agent && agent.status !== 'exited') {
      send({ type: 'input', id, data: text + '\r' });
      sent++;
    }
  }

  input.value = '';
  autoResizeTextarea(input);
  showToast(`Message sent to ${sent} agent${sent !== 1 ? 's' : ''}`, 'success');
  playSound('sent');

  // Refocus terminal after sending
  if (activeAgentId) {
    const agent = agents.get(activeAgentId);
    if (agent) agent.terminal.focus();
  }
}

// ═══════════════════════════════════════════
// Cycle 5: Cross-Agent Search
// ═══════════════════════════════════════════

let crossSearchVisible = false;

function openCrossAgentSearch() {
  if (crossSearchVisible) { closeCrossAgentSearch(); return; }
  crossSearchVisible = true;

  const overlay = document.createElement('div');
  overlay.id = 'cross-search-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="cross-search-container">
      <div class="cross-search-header">
        <svg class="palette-search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="6.5" cy="6.5" r="4.5"/>
          <path d="M10 10l4 4"/>
        </svg>
        <input type="text" class="cross-search-input" placeholder="Search across all agents..." autocomplete="off" spellcheck="false">
        <kbd class="palette-esc">Esc</kbd>
      </div>
      <div class="cross-search-results"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  const input = overlay.querySelector('.cross-search-input');
  const results = overlay.querySelector('.cross-search-results');

  let searchTimeout;
  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      performCrossSearch(input.value, results);
    }, 150);
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      closeCrossAgentSearch();
    }
    if (e.key === 'Enter') {
      // Select first result
      const first = results.querySelector('.cross-search-result');
      if (first) first.click();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCrossAgentSearch();
  });

  setTimeout(() => input.focus(), 50);
}

function closeCrossAgentSearch() {
  crossSearchVisible = false;
  const overlay = $('#cross-search-overlay');
  if (overlay) overlay.remove();
}

function performCrossSearch(query, resultsContainer) {
  if (!query || query.length < 2) {
    resultsContainer.innerHTML = '<div class="cross-search-hint">Type at least 2 characters to search</div>';
    return;
  }

  const lowerQuery = query.toLowerCase();
  const allResults = [];

  for (const agent of agents.values()) {
    const buffer = agent.terminal.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.toLowerCase().includes(lowerQuery)) {
        allResults.push({
          agentId: agent.id,
          agentName: agent.name,
          lineIndex: i,
          text: text.trim(),
        });
      }
    }
  }

  if (allResults.length === 0) {
    resultsContainer.innerHTML = '<div class="cross-search-hint">No matches found</div>';
    return;
  }

  // Group by agent
  const grouped = new Map();
  for (const r of allResults) {
    if (!grouped.has(r.agentId)) {
      grouped.set(r.agentId, { agentName: r.agentName, matches: [] });
    }
    grouped.get(r.agentId).matches.push(r);
  }

  let html = '';
  let totalCount = 0;
  for (const [agentId, group] of grouped) {
    const maxShow = 10; // Show at most 10 matches per agent
    const matches = group.matches.slice(0, maxShow);
    totalCount += group.matches.length;
    html += `<div class="cross-search-group">
      <div class="cross-search-agent-header">${escapeHtml(group.agentName)} (${group.matches.length} match${group.matches.length !== 1 ? 'es' : ''})</div>`;
    for (const m of matches) {
      // Highlight the match in the text
      const idx = m.text.toLowerCase().indexOf(lowerQuery);
      let displayText = m.text;
      if (displayText.length > 120) {
        // Show context around the match
        const start = Math.max(0, idx - 40);
        const end = Math.min(displayText.length, idx + query.length + 40);
        displayText = (start > 0 ? '...' : '') + displayText.substring(start, end) + (end < m.text.length ? '...' : '');
      }
      const escapedText = escapeHtml(displayText);
      // Re-highlight after escaping
      const highlightedText = escapedText.replace(
        new RegExp(escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
        '<mark class="cross-search-mark">$&</mark>'
      );
      html += `<div class="cross-search-result" data-agent-id="${agentId}" data-line="${m.lineIndex}">
        <span class="cross-search-line-num">L${m.lineIndex + 1}</span>
        <span class="cross-search-text">${highlightedText}</span>
      </div>`;
    }
    if (group.matches.length > maxShow) {
      html += `<div class="cross-search-more">...and ${group.matches.length - maxShow} more</div>`;
    }
    html += '</div>';
  }

  html = `<div class="cross-search-summary">${totalCount} result${totalCount !== 1 ? 's' : ''} across ${grouped.size} agent${grouped.size !== 1 ? 's' : ''}</div>` + html;

  resultsContainer.innerHTML = html;

  // Bind click handlers to switch to agent and scroll
  for (const result of resultsContainer.querySelectorAll('.cross-search-result')) {
    result.addEventListener('click', () => {
      const agentId = result.dataset.agentId;
      const lineIdx = parseInt(result.dataset.line);
      closeCrossAgentSearch();
      switchToAgent(agentId);
      // Scroll to the matching line
      const agent = agents.get(agentId);
      if (agent) {
        agent.terminal.scrollToLine(lineIdx);
      }
    });
  }
}

// ═══════════════════════════════════════════
// Preemptive UX: Last Line + Smart Status Handlers
// ═══════════════════════════════════════════

function onLastLine(msg) {
  agentLastLine.set(msg.id, msg.line);
  // Update the preview element in the sidebar if it exists
  const previewEl = document.querySelector(`.agent-last-line[data-agent-id="${msg.id}"]`);
  if (previewEl) {
    previewEl.textContent = msg.line;
  }
}

function onSmartStatus(msg) {
  agentSmartStatus.set(msg.id, msg.smartStatus);
  renderSidebar();

  // Show toast for error detection
  if (msg.smartStatus === 'error') {
    const agent = agents.get(msg.id);
    const name = agent ? agent.name : msg.name || msg.id;
    showToast(`${name}: Error detected in output`, 'error');
    addActivity('!', `Error detected in "${name}"`, 'error');
    playSound('error');
  }

  // Show toast for completion detection
  if (msg.smartStatus === 'complete') {
    const agent = agents.get(msg.id);
    const name = agent ? agent.name : msg.name || msg.id;
    addActivity('\u2713', `"${name}" task completed`, 'success');
    playSound('complete');
  }

  // Show toast for idle warning
  if (msg.smartStatus === 'idle') {
    const agent = agents.get(msg.id);
    const name = agent ? agent.name : msg.name || msg.id;
    addActivity('\u23F3', `"${name}" has been idle for 3+ minutes`, 'warning');
  }
}

// ═══════════════════════════════════════════
// Preemptive UX: "What Did I Miss?" Away Summary
// ═══════════════════════════════════════════

function initAwaySummary() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      tabHiddenSince = Date.now();
      awayOutputTracker.clear();
    } else {
      if (tabHiddenSince !== null) {
        const awayDuration = Date.now() - tabHiddenSince;
        tabHiddenSince = null;

        // Only show if away for 60+ seconds and there was activity
        if (awayDuration >= 60000 && awayOutputTracker.size > 0) {
          showAwaySummary();
        } else {
          awayOutputTracker.clear();
        }
      }
    }
  });
}

function showAwaySummary() {
  // Remove existing summary
  const existing = $('#away-summary');
  if (existing) existing.remove();

  if (awayOutputTracker.size === 0) return;

  const panel = document.createElement('div');
  panel.id = 'away-summary';
  panel.className = 'away-summary';

  let html = '<div class="away-summary-header">';
  html += '<span class="away-summary-title">What you missed</span>';
  html += '<button class="btn btn-icon-only btn-small away-summary-dismiss" title="Dismiss">';
  html += '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>';
  html += '</button></div>';
  html += '<div class="away-summary-items">';

  for (const [agentId, tracker] of awayOutputTracker) {
    const agent = agents.get(agentId);
    if (!agent) continue;

    html += `<div class="away-summary-agent" data-agent-id="${agentId}">`;
    html += `<div class="away-summary-agent-header">`;
    html += `<span class="away-summary-agent-name">${escapeHtml(agent.name)}</span>`;
    html += `<span class="away-summary-line-count">${tracker.lineCount} lines</span>`;
    html += `</div>`;
    if (tracker.lastLines.length > 0) {
      html += `<div class="away-summary-preview">`;
      for (const line of tracker.lastLines) {
        html += `<div class="away-summary-line">${escapeHtml(line)}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += '</div>';
  panel.innerHTML = html;

  const terminalArea = $('#terminal-area');
  if (terminalArea) {
    terminalArea.appendChild(panel);
  }

  // Bind click handlers
  panel.querySelector('.away-summary-dismiss').addEventListener('click', () => {
    dismissAwaySummary();
  });

  for (const item of panel.querySelectorAll('.away-summary-agent')) {
    item.addEventListener('click', () => {
      switchToAgent(item.dataset.agentId);
      dismissAwaySummary();
    });
  }

  // Auto-dismiss after 15 seconds
  setTimeout(() => dismissAwaySummary(), 15000);

  // Clear the tracker
  awayOutputTracker.clear();
}

function dismissAwaySummary() {
  const el = $('#away-summary');
  if (el) {
    el.classList.add('away-summary-out');
    setTimeout(() => el.remove(), 250);
  }
}

// ═══════════════════════════════════════════
// Preemptive UX: Agent Status Peek (Hover Popover)
// ═══════════════════════════════════════════

function showAgentPopover(agentEl, agentId) {
  hideAgentPopover();
  hoverPopoverAgentId = agentId;

  const agent = agents.get(agentId);
  if (!agent) return;

  const popover = document.createElement('div');
  popover.id = 'agent-popover';
  popover.className = 'agent-popover';

  // Gather last 5 lines from terminal buffer (ANSI-stripped)
  const buffer = agent.terminal.buffer.active;
  const termLines = [];
  const startIdx = Math.max(0, buffer.length - 5);
  for (let i = startIdx; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) {
      const text = line.translateToString(true).trim();
      if (text) termLines.push(text);
    }
  }
  // Only keep last 5 non-empty lines
  while (termLines.length > 5) termLines.shift();

  const statusLabel = agent.status === 'active' ? 'Active' :
                      agent.status === 'waiting' ? 'Waiting for input' :
                      'Exited';
  const smartSt = agentSmartStatus.get(agentId) || 'active';
  const smartLabel = smartSt === 'error' ? ' (Error detected)' :
                     smartSt === 'idle' ? ' (Idle 3+ min)' :
                     smartSt === 'complete' ? ' (Task complete)' : '';
  const elapsed = agent.startedAt ? formatElapsed(agent.startedAt) : 'unknown';
  const questionText = agent.question ? agent.question.substring(0, 120) : null;

  let html = '<div class="popover-section">';
  html += `<div class="popover-status"><span class="popover-status-dot status-${agent.status}"></span> ${statusLabel}${smartLabel}</div>`;
  html += `<div class="popover-meta">Running for ${elapsed}</div>`;
  html += `<div class="popover-meta">Dir: ${escapeHtml(shortenPath(agent.cwd))}</div>`;
  html += '</div>';

  if (questionText) {
    html += '<div class="popover-section popover-question">';
    html += `<div class="popover-label">Pending Question</div>`;
    html += `<div class="popover-question-text">${escapeHtml(questionText)}</div>`;
    html += '</div>';
  }

  if (termLines.length > 0) {
    html += '<div class="popover-section">';
    html += '<div class="popover-label">Recent Output</div>';
    html += '<div class="popover-output">';
    for (const line of termLines) {
      html += `<div class="popover-output-line">${escapeHtml(line.substring(0, 80))}</div>`;
    }
    html += '</div></div>';
  }

  popover.innerHTML = html;
  document.body.appendChild(popover);

  // Position to the right of the sidebar, aligned with the agent item
  const rect = agentEl.getBoundingClientRect();
  const sidebar = $('#sidebar');
  const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : { right: 280 };

  popover.style.top = `${Math.max(60, Math.min(rect.top, window.innerHeight - 300))}px`;
  popover.style.left = `${sidebarRect.right + 4}px`;

  // Dismiss when mouse leaves the popover
  popover.addEventListener('mouseleave', () => {
    hideAgentPopover();
  });
}

function hideAgentPopover() {
  hoverPopoverAgentId = null;
  const popover = $('#agent-popover');
  if (popover) popover.remove();
}

// ═══════════════════════════════════════════
// Sidebar Rendering
// ═══════════════════════════════════════════

function renderSidebar() {
  sidebarDirty = true;
  if (!sidebarRafScheduled) {
    sidebarRafScheduled = true;
    requestAnimationFrame(() => {
      sidebarRafScheduled = false;
      if (sidebarDirty) {
        sidebarDirty = false;
        renderSidebarNow();
      }
    });
  }
}

function renderSidebarNow() {
  renderAgentList();
  renderQuestionList();
}

function getColorLabelStyle(colorLabel) {
  const colors = {
    red: '#ef4444',
    orange: '#f59e0b',
    green: '#34d399',
    blue: '#60a5fa',
    purple: '#c084fc',
  };
  return colors[colorLabel] || null;
}

function getSortedAgents() {
  const all = Array.from(agents.values());
  const order = loadAgentOrder();

  // Sort: pinned first, then by saved order, then by insertion order
  all.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    // Within same pin group, use saved order
    const aIdx = order.indexOf(a.id);
    const bIdx = order.indexOf(b.id);
    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;
    return 0;
  });
  return all;
}

function renderAgentList() {
  const list = $('#agent-list');
  const countEl = $('#agent-count');
  list.innerHTML = '';
  countEl.textContent = agents.size;

  const sorted = getFilteredSortedAgents();
  // Build a map from agent id to its global sorted index (for shortcut labels)
  const allSorted = getSortedAgents();
  const globalIndexMap = new Map();
  allSorted.forEach((a, i) => globalIndexMap.set(a.id, i + 1));

  for (const agent of sorted) {
    const globalIdx = globalIndexMap.get(agent.id) || 0;
    const el = document.createElement('div');
    el.className = `agent-item${agent.id === activeAgentId ? ' active' : ''}`;
    el.dataset.agentId = agent.id;

    const unreadDot = agent.hasUnread
      ? '<span class="unread-dot" title="New output"></span>'
      : '';

    const pinIcon = agent.pinned
      ? '<span class="agent-pin" title="Pinned">\u{1F4CC}</span>'
      : '';

    // (new-lines badge removed: was spamming sidebar and making agents unclickable)

    // Apply color label to status dot if set (and not overriding status color)
    const colorStyle = agent.colorLabel && agent.status !== 'waiting'
      ? ` style="background:${getColorLabelStyle(agent.colorLabel)};box-shadow:0 0 8px ${getColorLabelStyle(agent.colorLabel)}40;"`
      : '';

    // Cycle 6: Elapsed time
    const elapsed = agent.startedAt ? formatElapsed(agent.startedAt) : '';

    // Cycle 6: Idle detection (dim if no output for 60+ seconds and active)
    const lastOut = agentLastOutputTime.get(agent.id) || Date.now();
    const idleSecs = (Date.now() - lastOut) / 1000;
    const isIdle = agent.status === 'active' && idleSecs > 60;

    // Cycle 6: Agent health pulse - unique animation delay per agent
    const pulseDelay = (parseInt(agent.id.replace('agent-', ''), 10) * 700) % 3000;
    const pulseDotStyle = agent.status === 'active' && !isIdle
      ? ` style="animation-delay:${pulseDelay}ms;${colorStyle ? colorStyle.replace(/ style="/, '') : ''}"`
      : colorStyle;

    // Cycle 7: Sticky note
    const notes = getAgentNotes();
    const noteText = notes[agent.id] || '';
    const noteHtml = noteText
      ? `<div class="agent-note" title="${escapeAttr(noteText)}">${escapeHtml(noteText)}</div>`
      : '';

    // Preemptive UX: Smart status icon overlay
    const smartSt = agentSmartStatus.get(agent.id) || 'active';
    let smartIcon = '';
    if (smartSt === 'error') {
      smartIcon = '<span class="agent-smart-icon agent-smart-error" title="Error detected">!</span>';
    } else if (smartSt === 'complete') {
      smartIcon = '<span class="agent-smart-icon agent-smart-complete" title="Task complete">\u2713</span>';
    } else if (smartSt === 'idle') {
      smartIcon = '<span class="agent-smart-icon agent-smart-idle" title="Idle 3+ min">\u23F3</span>';
    }

    // Preemptive UX: Last line preview
    const lastLine = agentLastLine.get(agent.id) || '';
    const lastLineHtml = lastLine
      ? `<div class="agent-last-line" data-agent-id="${agent.id}">${escapeHtml(lastLine)}</div>`
      : '';

    // ITEM 3: Show command in small text
    const cmdText = agent.command || 'claude';
    const cmdDisplay = cmdText.length > 35 ? cmdText.substring(0, 35) + '...' : cmdText;

    // ITEM 3: Progress bar for active agents producing output
    const agentLastOut = agentLastOutputTime.get(agent.id) || 0;
    const outputRecent = (Date.now() - agentLastOut) < 2000;
    const showProgressBar = agent.status === 'active' && outputRecent;

    el.innerHTML = `
      <div class="agent-status-dot-wrapper">
        <div class="agent-status-dot status-${agent.status}${isIdle ? ' agent-idle' : ''}"${pulseDotStyle}></div>
        ${smartIcon}
      </div>
      <div class="agent-details">
        <div class="agent-name-row">
          <span class="agent-name">${escapeHtml(agent.name)}</span>
          ${unreadDot}
          ${pinIcon}
          ${elapsed ? `<span class="agent-elapsed" title="Running for ${elapsed}">${elapsed}</span>` : ''}
        </div>
        <div class="agent-command" title="${escapeAttr(cmdText)}">${escapeHtml(cmdDisplay)}</div>
        <div class="agent-path">${escapeHtml(shortenPath(agent.cwd))}</div>
        ${lastLineHtml}
        ${noteHtml}
      </div>
      ${globalIdx <= 9 ? `<span class="agent-shortcut">\u2318${globalIdx}</span>` : ''}
      ${showProgressBar ? '<div class="agent-progress-bar"><div class="agent-progress-bar-inner"></div></div>' : ''}
    `;

    if (isIdle) el.classList.add('agent-idle-entry');

    // Cycle 5: Multi-select highlight
    if (multiSelectedAgentIds.has(agent.id)) {
      el.classList.add('multi-selected');
    }

    el.addEventListener('click', (e) => handleAgentClick(agent.id, e));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, agent.id);
    });

    // UX Polish: Double-click agent name to rename
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startInlineRename(agent);
    });

    // Preemptive UX: Hover popover (500ms delay)
    el.addEventListener('mouseenter', () => {
      if (hoverPopoverTimer) clearTimeout(hoverPopoverTimer);
      hoverPopoverTimer = setTimeout(() => {
        showAgentPopover(el, agent.id);
      }, 500);
    });
    el.addEventListener('mouseleave', () => {
      if (hoverPopoverTimer) { clearTimeout(hoverPopoverTimer); hoverPopoverTimer = null; }
      // Delay hide slightly so user can move to popover
      setTimeout(() => {
        const popover = $('#agent-popover');
        if (popover && !popover.matches(':hover')) {
          hideAgentPopover();
        }
      }, 100);
    });

    // UX Polish: Drag to reorder agents
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', agent.id);
      el.classList.add('agent-dragging');
      // Use a slight delay so the dragging class applies visually
      setTimeout(() => el.style.opacity = '0.4', 0);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('agent-dragging');
      el.style.opacity = '';
      // Remove any lingering drop indicators
      for (const item of list.querySelectorAll('.agent-item')) {
        item.classList.remove('drag-over-above', 'drag-over-below');
      }
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        el.classList.add('drag-over-above');
        el.classList.remove('drag-over-below');
      } else {
        el.classList.add('drag-over-below');
        el.classList.remove('drag-over-above');
      }
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over-above', 'drag-over-below');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over-above', 'drag-over-below');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (!draggedId || draggedId === agent.id) return;

      // Determine insert position
      const rect = el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const insertBefore = e.clientY < midY;

      // Build new order from current sorted list
      const currentOrder = getSortedAgents().map(a => a.id);
      // Remove the dragged item
      const fromIdx = currentOrder.indexOf(draggedId);
      if (fromIdx < 0) return;
      currentOrder.splice(fromIdx, 1);
      // Find target position
      let toIdx = currentOrder.indexOf(agent.id);
      if (!insertBefore) toIdx++;
      currentOrder.splice(toIdx, 0, draggedId);

      saveAgentOrder(currentOrder);
      renderSidebar();
    });

    list.appendChild(el);
  }
}

function renderQuestionList() {
  const list = $('#question-list');
  const badge = $('#question-count');
  const noQuestions = $('#no-questions');

  // Save focus state before clearing
  let focusedAgentId = null;
  let focusedCursorPos = 0;
  const focusedInput = list.querySelector('.question-input:focus');
  if (focusedInput) {
    focusedAgentId = focusedInput.dataset.agentId;
    focusedCursorPos = focusedInput.selectionStart || 0;
  }

  list.innerHTML = '';

  let count = 0;
  for (const agent of agents.values()) {
    if (!agent.question) continue;
    count++;

    const el = document.createElement('div');
    el.className = 'question-item';

    el.innerHTML = `
      <div class="question-agent-row">
        <span class="question-agent">${escapeHtml(agent.name)}</span>
        <span class="question-time">${timeAgo(agent.questionTime)}</span>
      </div>
      <div class="question-text">${escapeHtml(agent.question)}</div>
      <div class="question-reply">
        <input type="text" class="question-input" placeholder="Type reply..."
               data-agent-id="${agent.id}" autocomplete="off" spellcheck="false">
        <button class="btn btn-small btn-primary question-send-btn" data-agent-id="${agent.id}">Send</button>
      </div>
      <button class="btn btn-ghost btn-small question-jump" data-agent-id="${agent.id}">
        Jump to terminal
      </button>
    `;

    // Send reply handler
    const input = el.querySelector('.question-input');
    const sendBtn = el.querySelector('.question-send-btn');

    const sendReply = () => {
      const reply = input.value.trim();
      if (!reply) return;
      send({ type: 'input', id: agent.id, data: reply + '\r' });
      input.value = '';
      showToast(`Reply sent to ${agent.name}`, 'success');
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendReply(); }
      // Stop propagation so global keyboard shortcuts don't fire
      e.stopPropagation();
    });
    sendBtn.addEventListener('click', sendReply);

    // Jump to terminal
    el.querySelector('.question-jump').addEventListener('click', () => {
      switchToAgent(agent.id);
    });

    list.appendChild(el);
  }

  // ITEM 4: Bulk reply bar when 2+ pending questions
  if (count >= 2) {
    const bulkBar = document.createElement('div');
    bulkBar.className = 'bulk-reply';
    bulkBar.innerHTML = `
      <div class="bulk-reply-row">
        <input type="text" class="bulk-reply-input" placeholder="Reply to all ${count} agents..." autocomplete="off" spellcheck="false">
        <button class="btn btn-small btn-primary bulk-reply-send">Send to All</button>
      </div>
      <div class="bulk-reply-hint"><kbd>\u2318\u21E7Y</kbd> sends "y" to all</div>
    `;

    const bulkInput = bulkBar.querySelector('.bulk-reply-input');
    const bulkSend = bulkBar.querySelector('.bulk-reply-send');

    const sendBulk = () => {
      const val = bulkInput.value.trim();
      if (!val) return;
      let sent = 0;
      for (const a of agents.values()) {
        if (a.question !== null) {
          send({ type: 'input', id: a.id, data: val + '\r' });
          sent++;
        }
      }
      bulkInput.value = '';
      showToast(`Reply sent to ${sent} agents`, 'success');
    };

    bulkInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); sendBulk(); }
    });
    bulkSend.addEventListener('click', sendBulk);

    list.insertBefore(bulkBar, list.firstChild);
  }

  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
    noQuestions.classList.add('hidden');
    // Cycle 7: Favicon badge + tab title rotation
    updateFaviconBadge(true);
    startTabTitleRotation();
  } else {
    badge.classList.add('hidden');
    noQuestions.classList.remove('hidden');
    // Cycle 7: Clear favicon badge + stop tab rotation
    updateFaviconBadge(false);
    stopTabTitleRotation();
    const activeAgents = Array.from(agents.values()).filter(a => a.status !== 'exited').length;
    document.title = activeAgents > 0 ? `Claude Nexus (${activeAgents})` : 'Claude Nexus';
  }

  // Restore focus after rebuild (ITEM 1)
  if (focusedAgentId) {
    const restoredInput = list.querySelector(`.question-input[data-agent-id="${focusedAgentId}"]`);
    if (restoredInput) {
      restoredInput.focus();
      restoredInput.setSelectionRange(focusedCursorPos, focusedCursorPos);
    }
  }
}

// Periodically refresh question timestamps
const _questionTimerInterval = setInterval(() => {
  for (const el of $$('.question-time')) {
    const item = el.closest('.question-item');
    if (!item) continue;
    const input = item.querySelector('.question-input');
    if (!input) continue;
    const agent = agents.get(input.dataset.agentId);
    if (agent && agent.questionTime) {
      el.textContent = timeAgo(agent.questionTime);
    }
  }
}, 10000);
_intervals.add(_questionTimerInterval);

// ═══════════════════════════════════════════
// File Preview
// ═══════════════════════════════════════════

function togglePreview() {
  previewVisible = !previewVisible;
  const panel = $('#preview-panel');
  const handle = $('#preview-resize-handle');

  if (previewVisible) {
    panel.classList.remove('hidden');
    panel.classList.add('panel-entering');
    panel.style.width = previewWidth + 'px';
    if (handle) handle.style.display = '';
    setTimeout(() => panel.classList.remove('panel-entering'), 200);
  } else {
    panel.classList.add('hidden');
    if (handle) handle.style.display = 'none';
  }

  refitActiveTerminal();

  if (previewVisible && activeAgentId) {
    const agent = agents.get(activeAgentId);
    if (agent) {
      previewHistory = [];
      browseFiles(agent.cwd);
    }
  }
}

function browseFiles(dirPath) {
  if (previewHistory.length >= MAX_PREVIEW_HISTORY) {
    previewHistory = previewHistory.slice(-20);
  }
  previewHistory.push(dirPath);
  send({ type: 'browse', path: dirPath, showHidden: showHiddenFiles });
}

function renderFileBrowser(msg) {
  const browser = $('#file-browser');
  const viewer = $('#file-viewer');
  browser.classList.remove('hidden');
  viewer.classList.add('hidden');
  $('#preview-filename').textContent = shortenPath(msg.path);

  let html = '';

  // Parent directory
  if (msg.parent && msg.parent !== msg.path) {
    html += `<div class="file-entry file-directory" data-path="${escapeAttr(msg.parent)}" data-type="directory">
      <span class="file-icon">\u21A9</span>
      <span class="file-name">..</span>
    </div>`;
  }

  for (const entry of msg.entries) {
    const icon = entry.type === 'directory' ? '\uD83D\uDCC1' : getFileIcon(entry.name);
    const draggable = entry.type === 'file' ? ' draggable="true"' : '';
    html += `<div class="file-entry file-${entry.type}" data-path="${escapeAttr(entry.path)}" data-type="${entry.type}"${draggable}>
      <span class="file-icon">${icon}</span>
      <span class="file-name">${escapeHtml(entry.name)}</span>
    </div>`;
  }

  if (msg.entries.length === 0) {
    html += '<div class="empty-section"><span>Empty directory</span></div>';
  }

  browser.innerHTML = html;

  for (const el of browser.querySelectorAll('.file-entry')) {
    el.addEventListener('click', () => {
      if (el.dataset.type === 'directory') {
        browseFiles(el.dataset.path);
      } else {
        send({ type: 'readFile', path: el.dataset.path });
      }
    });
  }
}

function renderFileContent(msg) {
  // Open file content in the horizontal split above the terminal (ITEM 1)
  openFileSplit(msg);
}

function openFileSplit(msg) {
  const split = $('#file-split');
  const resizer = $('#file-split-resizer');
  if (!split) return;

  // Set filename
  const nameEl = $('#file-split-name');
  if (nameEl) nameEl.textContent = msg.name;

  // Render syntax-highlighted content
  const code = $('#file-split-code');
  if (window.hljs && msg.language && msg.language !== 'plaintext') {
    try {
      const highlighted = window.hljs.highlight(msg.content, { language: msg.language, ignoreIllegals: true });
      const lines = highlighted.value.split('\n');
      code.innerHTML = lines.map((line, i) =>
        `<span class="code-line"><span class="line-number">${i + 1}</span>${line}</span>`
      ).join('\n');
      code.className = `hljs language-${msg.language}`;
    } catch {
      renderFileSplitPlain(code, msg.content);
    }
  } else {
    renderFileSplitPlain(code, msg.content);
  }

  // Show the split and resizer
  split.classList.remove('hidden');
  split.style.height = fileSplitHeight + 'px';
  if (resizer) resizer.classList.remove('hidden');
  fileSplitVisible = true;

  // Refit terminal since available space changed
  refitActiveTerminal();
}

function renderFileSplitPlain(codeEl, content) {
  const lines = content.split('\n');
  const html = lines.map((line, i) =>
    `<span class="code-line"><span class="line-number">${i + 1}</span>${escapeHtml(line)}</span>`
  ).join('\n');
  codeEl.innerHTML = html;
  codeEl.className = '';
}

function closeFileSplit() {
  const split = $('#file-split');
  const resizer = $('#file-split-resizer');
  if (split) split.classList.add('hidden');
  if (resizer) resizer.classList.add('hidden');
  fileSplitVisible = false;
  refitActiveTerminal();
}

function getFileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    js: '\uD83D\uDCDC', jsx: '\uD83D\uDCDC', ts: '\uD83D\uDCD8', tsx: '\uD83D\uDCD8',
    py: '\uD83D\uDC0D', rb: '\uD83D\uDC8E', go: '\uD83D\uDD37', rs: '\uD83E\uDD80',
    html: '\uD83C\uDF10', css: '\uD83C\uDFA8', scss: '\uD83C\uDFA8',
    json: '\uD83D\uDCCB', yaml: '\uD83D\uDCCB', yml: '\uD83D\uDCCB', toml: '\uD83D\uDCCB',
    md: '\uD83D\uDCDD', txt: '\uD83D\uDCDD',
    sh: '\u26A1', bash: '\u26A1', zsh: '\u26A1',
    png: '\uD83D\uDDBC', jpg: '\uD83D\uDDBC', jpeg: '\uD83D\uDDBC', gif: '\uD83D\uDDBC', svg: '\uD83D\uDDBC',
    pdf: '\uD83D\uDCD5',
  };
  return map[ext] || '\uD83D\uDCC4';
}

// ═══════════════════════════════════════════
// Modal
// ═══════════════════════════════════════════

function openModal() {
  $('#modal-overlay').classList.remove('hidden');
  $('#agent-name').value = '';
  $('#agent-cwd').value = os_homedir();
  $('#agent-command').value = 'claude';
  $('#folder-browser').classList.add('hidden');

  // Preemptive UX: Reset startup prompt section
  const startupInput = $('#agent-startup-prompt');
  if (startupInput) startupInput.value = '';
  const startupSection = $('#startup-prompt-section');
  if (startupSection) startupSection.classList.add('collapsed');
  const startupChevron = document.querySelector('.startup-chevron');
  if (startupChevron) startupChevron.classList.remove('expanded');

  setTimeout(() => $('#agent-name').focus(), 80);
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  $('#folder-browser').classList.add('hidden');
  if (activeAgentId) {
    const agent = agents.get(activeAgentId);
    if (agent) agent.terminal.focus();
  }
}

function handleCreateAgent() {
  const name = $('#agent-name').value.trim();
  const cwd = $('#agent-cwd').value.trim();
  const command = $('#agent-command').value.trim() || 'claude';

  let valid = true;
  if (!name) {
    $('#agent-name').classList.add('shake');
    setTimeout(() => $('#agent-name').classList.remove('shake'), 400);
    valid = false;
  }
  if (!cwd) {
    $('#agent-cwd').classList.add('shake');
    setTimeout(() => $('#agent-cwd').classList.remove('shake'), 400);
    valid = false;
  }
  if (!valid) return;

  // Preemptive UX: Get startup prompt if provided
  const startupInput = $('#agent-startup-prompt');
  const startupPrompt = startupInput ? startupInput.value.trim() : '';

  // Save last-used startup prompt for convenience
  if (startupPrompt) {
    try { localStorage.setItem(STARTUP_PROMPT_KEY, startupPrompt); } catch {}
  }

  saveRecentDir(cwd);
  showPendingPlaceholder(name, cwd);
  send({ type: 'create', name, cwd, command, startupPrompt });
  closeModal();
  showToast(`Starting ${name}...`, 'success');
}

function showPendingPlaceholder(name, cwd) {
  pendingAgentName = name;
  const list = $('#agent-list');
  if (!list) return;

  // Remove existing placeholder
  const existing = list.querySelector('.agent-item-pending');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.className = 'agent-item agent-item-pending';
  el.innerHTML = `
    <div class="agent-spinner"></div>
    <div class="agent-details">
      <div class="agent-name-row">
        <span class="agent-name" style="opacity:0.6;">${escapeHtml(name)}</span>
      </div>
      <div class="agent-path" style="opacity:0.4;">${escapeHtml(shortenPath(cwd))}</div>
    </div>
    <span class="agent-shortcut" style="opacity:0.5;">...</span>
  `;
  list.appendChild(el);
}

function removePendingPlaceholder() {
  pendingAgentName = null;
  const placeholder = document.querySelector('.agent-item-pending');
  if (placeholder) placeholder.remove();
}

// ═══════════════════════════════════════════
// Folder Browser (Modal)
// ═══════════════════════════════════════════
//
// Simple rules:
//   - Click a folder = navigate INTO it (see its contents)
//   - Click ".." = go up one level
//   - Click "Use This Folder" = select current directory and close
//   - The path input always updates as you navigate

function browseFolders(dirPath) {
  const el = $('#folder-browser');
  el.innerHTML = '<div class="folder-loading">Loading...</div>';

  fetch('/api/browse?path=' + encodeURIComponent(dirPath))
    .then(r => {
      if (!r.ok) throw new Error('Cannot read directory');
      return r.json();
    })
    .then(data => {
      if (data.error) {
        el.innerHTML = '<div class="folder-error">' + escapeHtml(data.error) + '</div>';
        return;
      }

      // Update the text input to show current path
      $('#agent-cwd').value = data.path;

      let html = '';

      // Current location header
      html += '<div class="folder-current-path">' + escapeHtml(data.path) + '</div>';

      // Use This Folder button at TOP (most important action)
      html += '<div class="folder-select-btn" data-path="' + escapeAttr(data.path) + '">Use This Folder</div>';

      // Go up
      if (data.parent && data.parent !== data.path) {
        html += '<div class="folder-entry folder-up" data-path="' + escapeAttr(data.parent) + '">\u2B06 ..</div>';
      }

      // List all directories (click = navigate into)
      const dirs = (data.entries || []).filter(function(e) { return e.type === 'directory'; });
      for (let i = 0; i < dirs.length; i++) {
        html += '<div class="folder-entry folder-dir" data-path="' + escapeAttr(dirs[i].path) + '">\uD83D\uDCC1 ' + escapeHtml(dirs[i].name) + '</div>';
      }

      if (dirs.length === 0) {
        html += '<div class="folder-empty">No sub-folders</div>';
      }

      el.innerHTML = html;

      // Click "Use This Folder" = select and close
      var selectBtn = el.querySelector('.folder-select-btn');
      if (selectBtn) {
        selectBtn.addEventListener('click', function() {
          $('#agent-cwd').value = selectBtn.dataset.path;
          el.classList.add('hidden');
        });
      }

      // Click any folder entry = navigate into it
      var entries = el.querySelectorAll('.folder-entry');
      for (var j = 0; j < entries.length; j++) {
        entries[j].addEventListener('click', function() {
          browseFolders(this.dataset.path);
        });
      }
    })
    .catch(function(err) {
      el.innerHTML = '<div class="folder-error">' + escapeHtml(err.message) + '</div>';
    });
}

// ═══════════════════════════════════════════
// Resize handling
// ═══════════════════════════════════════════

function refitActiveTerminal() {
  if (!activeAgentId) return;
  const agent = agents.get(activeAgentId);
  if (!agent) return;
  requestAnimationFrame(() => {
    try {
      agent.fitAddon.fit();
      send({ type: 'resize', id: activeAgentId, cols: agent.terminal.cols, rows: agent.terminal.rows });
    } catch {}
  });
}

let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(refitActiveTerminal, 50);
});

// ═══════════════════════════════════════════
// Focus / Zen Mode
// ═══════════════════════════════════════════

function toggleFocusMode() {
  focusModeActive = !focusModeActive;
  document.body.classList.toggle('focus-mode', focusModeActive);

  if (focusModeActive) {
    // Create the floating exit pill
    let pill = document.getElementById('focus-exit-pill');
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'focus-exit-pill';
      pill.className = 'focus-exit-pill';
      pill.textContent = 'Exit Focus Mode';
      pill.addEventListener('click', toggleFocusMode);
      document.body.appendChild(pill);
    }
    pill.style.display = '';
  } else {
    const pill = document.getElementById('focus-exit-pill');
    if (pill) pill.style.display = 'none';
  }

  // Refit the terminal after the transition
  setTimeout(refitActiveTerminal, 400);
}

// ═══════════════════════════════════════════
// Quick Agent Switcher Dropdown
// ═══════════════════════════════════════════

let agentSwitcherVisible = false;
let agentSwitcherHighlightIdx = -1;

function openAgentSwitcher() {
  closeAgentSwitcher();
  agentSwitcherVisible = true;
  agentSwitcherHighlightIdx = -1;

  const headerInfo = document.querySelector('.terminal-info');
  if (!headerInfo) return;

  const dropdown = document.createElement('div');
  dropdown.id = 'agent-switcher-dropdown';
  dropdown.className = 'agent-switcher-dropdown';

  const sorted = getSortedAgents();
  for (let i = 0; i < sorted.length; i++) {
    const agent = sorted[i];
    const item = document.createElement('div');
    item.className = 'agent-switcher-item';
    if (agent.id === activeAgentId) item.classList.add('switcher-active');
    item.dataset.agentId = agent.id;
    item.dataset.index = i;

    item.innerHTML = `
      <span class="agent-switcher-dot status-${agent.status}"></span>
      <span class="agent-switcher-name">${escapeHtml(agent.name)}</span>
    `;

    item.addEventListener('click', () => {
      switchToAgent(agent.id);
      closeAgentSwitcher();
    });

    dropdown.appendChild(item);
  }

  // Position relative to the terminal-info container
  headerInfo.style.position = 'relative';
  headerInfo.appendChild(dropdown);

  // Close on outside click
  const outsideHandler = (e) => {
    if (!dropdown.contains(e.target) && !e.target.closest('#terminal-agent-name')) {
      closeAgentSwitcher();
      document.removeEventListener('click', outsideHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', outsideHandler), 0);

  // Keyboard navigation
  const keyHandler = (e) => {
    if (!agentSwitcherVisible) {
      document.removeEventListener('keydown', keyHandler, true);
      return;
    }
    const items = dropdown.querySelectorAll('.agent-switcher-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      agentSwitcherHighlightIdx = Math.min(agentSwitcherHighlightIdx + 1, items.length - 1);
      updateSwitcherHighlight(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      agentSwitcherHighlightIdx = Math.max(agentSwitcherHighlightIdx - 1, 0);
      updateSwitcherHighlight(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (agentSwitcherHighlightIdx >= 0 && agentSwitcherHighlightIdx < items.length) {
        const agentId = items[agentSwitcherHighlightIdx].dataset.agentId;
        switchToAgent(agentId);
      }
      closeAgentSwitcher();
      document.removeEventListener('keydown', keyHandler, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAgentSwitcher();
      document.removeEventListener('keydown', keyHandler, true);
    }
  };
  document.addEventListener('keydown', keyHandler, true);
}

function updateSwitcherHighlight(items) {
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('switcher-highlighted', i === agentSwitcherHighlightIdx);
  }
}

function closeAgentSwitcher() {
  agentSwitcherVisible = false;
  agentSwitcherHighlightIdx = -1;
  const dropdown = document.getElementById('agent-switcher-dropdown');
  if (dropdown) dropdown.remove();
}

// ═══════════════════════════════════════════
// Textarea Auto-Resize Helper
// ═══════════════════════════════════════════

function autoResizeTextarea(textarea) {
  if (!textarea) return;
  // Reset to 1 row to get proper scrollHeight measurement
  textarea.style.height = 'auto';
  // Calculate based on scrollHeight but cap at max-height (set via CSS, ~120px / 4 lines)
  const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 21;
  const maxLines = 4;
  const maxHeight = lineHeight * maxLines + 20; // add padding
  const newHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = newHeight + 'px';

  // Dynamically adjust the terminal bottom padding based on input height
  const floatingInput = $('#floating-input');
  if (floatingInput && !floatingInput.classList.contains('hidden')) {
    const totalBarHeight = floatingInput.offsetHeight;
    const terminalInstances = $$('.terminal-instance');
    for (const inst of terminalInstances) {
      inst.style.bottom = totalBarHeight + 'px';
    }
  }
}

// ═══════════════════════════════════════════
// Keyboard Shortcuts
// ═══════════════════════════════════════════

document.addEventListener('keydown', (e) => {
  const isMeta = e.metaKey || e.ctrlKey;
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

  // Cmd+K: Command palette (works even in input fields)
  if (isMeta && e.key === 'k') {
    e.preventDefault();
    openCommandPalette();
    return;
  }

  // Cmd+N or Cmd+T: New agent
  if (isMeta && (e.key === 'n' || e.key === 't')) {
    e.preventDefault();
    openModal();
    return;
  }

  // Cmd+J: Focus first pending question input, or cycle to next (ITEM 5)
  if (isMeta && e.key === 'j') {
    e.preventDefault();
    const questionInputs = Array.from($$('#question-list .question-input'));
    if (questionInputs.length === 0) return;
    const currentlyFocused = questionInputs.findIndex(inp => inp === document.activeElement);
    if (currentlyFocused === -1) {
      questionInputs[0].focus();
    } else {
      const nextIdx = (currentlyFocused + 1) % questionInputs.length;
      questionInputs[nextIdx].focus();
    }
    return;
  }

  // Cmd+Shift+F: Toggle Focus / Zen Mode
  if (isMeta && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
    e.preventDefault();
    toggleFocusMode();
    return;
  }

  // Cmd+B: Toggle file preview
  if (isMeta && e.key === 'b' && !isInput) {
    e.preventDefault();
    togglePreview();
    return;
  }

  // Cmd+F: Search in terminal
  if (isMeta && e.key === 'f' && !isInput) {
    e.preventDefault();
    toggleSearchBar();
    return;
  }

  // Cmd+H: Toggle hidden files in file browser
  if (isMeta && e.key === 'h' && !isInput && previewVisible) {
    e.preventDefault();
    toggleHiddenFiles();
    return;
  }

  // Cmd+M: Toggle mute
  if (isMeta && e.key === 'm' && !isInput) {
    e.preventDefault();
    toggleMute();
    return;
  }

  // ? key: Toggle shortcut overlay (only outside inputs)
  if (e.key === '?' && !isInput && !isMeta) {
    e.preventDefault();
    toggleShortcutOverlay();
    return;
  }

  // Cmd+A: Select all agents (when not in input)
  if (isMeta && e.key === 'a' && !isInput && agents.size > 1) {
    e.preventDefault();
    selectAllAgents();
    return;
  }

  // Escape: Close focus mode, cross-search, command palette, shortcut overlay, context menu, workspace dropdown, confirm dialog, search bar, then modal, then multi-select
  if (e.key === 'Escape') {
    // Exit focus mode first
    if (focusModeActive) {
      toggleFocusMode();
      return;
    }
    // Close cross-agent search first
    if (crossSearchVisible) {
      closeCrossAgentSearch();
      return;
    }
    // Close command palette
    if (commandPaletteVisible) {
      closeCommandPalette();
      return;
    }
    // Close shortcut overlay
    if (shortcutOverlayVisible) {
      shortcutOverlayVisible = false;
      $('#shortcut-overlay').classList.add('hidden');
      return;
    }
    // Close context menu
    if (contextMenuAgentId) {
      hideContextMenu();
      return;
    }
    // Close workspace dropdown
    const wsDropdown = $('#workspace-dropdown');
    if (wsDropdown && !wsDropdown.classList.contains('hidden')) {
      wsDropdown.classList.add('hidden');
      return;
    }
    const confirmOverlay = $('#confirm-overlay');
    if (confirmOverlay && !confirmOverlay.classList.contains('hidden')) {
      confirmOverlay.classList.add('hidden');
      return;
    }
    if (searchBarVisible) {
      closeSearchBar();
      return;
    }
    // Close file split preview
    if (fileSplitVisible) {
      closeFileSplit();
      return;
    }
    // Close MCP manager
    if (mcpManagerVisible) {
      closeMcpManager();
      return;
    }
    if (!$('#modal-overlay').classList.contains('hidden')) {
      closeModal();
      return;
    }
    // Cycle 5: Clear multi-select on Escape
    if (isMultiSelectMode) {
      multiSelectedAgentIds.clear();
      isMultiSelectMode = false;
      renderSidebar();
      updateFloatingInputMultiMode();
      return;
    }
  }

  // Cmd+1-9: Switch agent by index (respects pin order)
  if (isMeta && e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key) - 1;
    const sorted = getSortedAgents();
    if (idx < sorted.length) {
      e.preventDefault();
      switchToAgent(sorted[idx].id);
    }
    return;
  }

  // Cmd+W: Close current agent
  if (isMeta && e.key === 'w' && !isInput && activeAgentId) {
    e.preventDefault();
    const agent = agents.get(activeAgentId);
    if (agent) {
      showConfirmDialog(`Close agent "${agent.name}"?`, () => {
        send({ type: 'destroy', id: agent.id });
      });
    }
    return;
  }

  // Cmd+Shift+Y: Accept all pending questions (handles both prompt styles)
  if (isMeta && e.shiftKey && (e.key === 'Y' || e.key === 'y')) {
    e.preventDefault();
    let sent = 0;
    for (const a of agents.values()) {
      if (a.question !== null) {
        // Send Enter first (selection menus), then y+Enter (text prompts)
        send({ type: 'input', id: a.id, data: '\r' });
        const agentId = a.id;
        setTimeout(() => {
          send({ type: 'input', id: agentId, data: 'y\r' });
        }, 150);
        sent++;
      }
    }
    if (sent > 0) {
      showToast(`Accepted ${sent} agent${sent > 1 ? 's' : ''}`, 'success');
    }
    return;
  }

  // Cmd+Shift+] / Cmd+Shift+[: Cycle agents
  if (isMeta && e.shiftKey && (e.key === '}' || e.key === '{')) {
    e.preventDefault();
    cycleAgent(e.key === '}' ? 1 : -1);
    return;
  }
});

function cycleAgent(direction) {
  const sorted = getSortedAgents();
  if (sorted.length < 2) return;
  const currentIdx = sorted.findIndex(a => a.id === activeAgentId);
  const nextIdx = (currentIdx + direction + sorted.length) % sorted.length;
  switchToAgent(sorted[nextIdx].id);
}

// ═══════════════════════════════════════════
// Terminal Search
// ═══════════════════════════════════════════

function toggleSearchBar() {
  if (searchBarVisible) { closeSearchBar(); return; }
  if (!activeAgentId) return;

  searchBarVisible = true;
  searchActiveAgentId = activeAgentId;

  const bar = document.createElement('div');
  bar.id = 'search-bar';
  bar.className = 'search-bar';
  bar.innerHTML = `
    <input type="text" id="search-input" placeholder="Search terminal..." autocomplete="off" spellcheck="false">
    <span id="search-count" class="search-count"></span>
    <button class="btn btn-icon-only btn-small" id="search-prev" title="Previous (Shift+Enter)">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 8l4-4 4 4"/></svg>
    </button>
    <button class="btn btn-icon-only btn-small" id="search-next" title="Next (Enter)">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4l4 4 4-4"/></svg>
    </button>
    <button class="btn btn-icon-only btn-small" id="search-close" title="Close (Esc)">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
    </button>
  `;

  const header = $('#terminal-header');
  header.parentNode.insertBefore(bar, header.nextSibling);

  const input = $('#search-input');
  const agent = agents.get(activeAgentId);

  input.addEventListener('input', () => {
    if (!agent) return;
    const term = input.value;
    if (term) {
      agent.searchAddon.findNext(term, { regex: false, caseSensitive: false, incremental: true });
    } else {
      agent.searchAddon.clearDecorations();
      $('#search-count').textContent = '';
    }
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      agent && agent.searchAddon.findNext(input.value, { regex: false, caseSensitive: false });
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      agent && agent.searchAddon.findPrevious(input.value, { regex: false, caseSensitive: false });
    }
    if (e.key === 'Escape') {
      closeSearchBar();
    }
  });

  $('#search-next').addEventListener('click', () => {
    agent && agent.searchAddon.findNext(input.value, { regex: false, caseSensitive: false });
  });
  $('#search-prev').addEventListener('click', () => {
    agent && agent.searchAddon.findPrevious(input.value, { regex: false, caseSensitive: false });
  });
  $('#search-close').addEventListener('click', closeSearchBar);

  setTimeout(() => input.focus(), 50);
  refitActiveTerminal();
}

function closeSearchBar() {
  searchBarVisible = false;
  const bar = $('#search-bar');
  if (bar) bar.remove();

  // Clear search highlights
  if (searchActiveAgentId) {
    const agent = agents.get(searchActiveAgentId);
    if (agent) {
      agent.searchAddon.clearDecorations();
      agent.terminal.focus();
    }
  }
  searchActiveAgentId = null;
  refitActiveTerminal();
}

// ═══════════════════════════════════════════
// Hidden Files Toggle
// ═══════════════════════════════════════════

function toggleHiddenFiles() {
  showHiddenFiles = !showHiddenFiles;
  showToast(showHiddenFiles ? 'Showing hidden files' : 'Hiding hidden files', 'info');
  // Re-browse current directory
  if (previewVisible && previewHistory.length > 0) {
    const currentDir = previewHistory[previewHistory.length - 1];
    send({ type: 'browse', path: currentDir, showHidden: showHiddenFiles });
  }
}

// ═══════════════════════════════════════════
// Context Menu
// ═══════════════════════════════════════════

function showContextMenu(e, agentId) {
  contextMenuAgentId = agentId;
  const menu = $('#context-menu');
  const colorsPanel = $('#context-menu-colors');
  colorsPanel.classList.add('hidden');
  menu.classList.remove('hidden');

  // Update pin label
  const agent = agents.get(agentId);
  const pinItem = menu.querySelector('[data-action="pin"] span');
  if (pinItem && agent) {
    pinItem.textContent = agent.pinned ? 'Unpin' : 'Pin to Top';
  }

  // Update note label
  const noteItem = menu.querySelector('[data-action="addnote"] span');
  if (noteItem && agent) {
    const notes = getAgentNotes();
    noteItem.textContent = notes[agent.id] ? 'Edit Note' : 'Add Note';
  }

  // Update auto-reply label
  const arItem = menu.querySelector('[data-action="autoreply"] span');
  if (arItem && agent) {
    const isEnabled = autoReplyGlobal || autoReplyAgents.has(agentId);
    arItem.textContent = isEnabled ? 'Disable Auto-Reply' : 'Enable Auto-Reply';
  }

  // Update color dot active states
  for (const dot of menu.querySelectorAll('.color-dot')) {
    dot.classList.toggle('active', (agent && agent.colorLabel || 'default') === dot.dataset.color);
  }

  // Position the menu
  let x = e.clientX;
  let y = e.clientY;
  // Clamp so it doesn't go offscreen
  const menuWidth = 180;
  const menuHeight = 240;
  if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
  if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // Close on next click outside
  const closeMenu = (evt) => {
    if (!menu.contains(evt.target)) {
      hideContextMenu();
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('contextmenu', closeMenu);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('contextmenu', closeMenu);
  }, 0);
}

function hideContextMenu() {
  const menu = $('#context-menu');
  menu.classList.add('hidden');
  contextMenuAgentId = null;
}

function initContextMenu() {
  const menu = $('#context-menu');

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.context-menu-item');
    const colorDot = e.target.closest('.color-dot');

    if (colorDot && contextMenuAgentId) {
      const agent = agents.get(contextMenuAgentId);
      if (agent) {
        const color = colorDot.dataset.color;
        agent.colorLabel = color === 'default' ? null : color;
        renderSidebar();
        showToast(`Color label updated`, 'info');
      }
      hideContextMenu();
      return;
    }

    if (!item) return;
    const action = item.dataset.action;
    const agent = agents.get(contextMenuAgentId);
    if (!agent && action !== 'color') return;

    switch (action) {
      case 'rename':
        hideContextMenu();
        startInlineRename(agent);
        break;

      case 'pin':
        agent.pinned = !agent.pinned;
        hideContextMenu();
        renderSidebar();
        showToast(agent.pinned ? `"${agent.name}" pinned to top` : `"${agent.name}" unpinned`, 'info');
        break;

      case 'addnote':
        hideContextMenu();
        startInlineNote(agent);
        break;

      case 'duplicate':
        hideContextMenu();
        send({ type: 'create', name: agent.name + ' (copy)', cwd: agent.cwd, command: agent.command || 'claude' });
        showToast(`Duplicating "${agent.name}"...`, 'success');
        addActivity('\u25B6', `Duplicated agent "${agent.name}"`, 'info');
        break;

      case 'autoreply':
        hideContextMenu();
        toggleAutoReplyAgent(agent.id);
        break;

      case 'color':
        // Toggle colors submenu
        const colorsPanel = $('#context-menu-colors');
        colorsPanel.classList.toggle('hidden');
        return; // Don't close menu

      case 'export':
        hideContextMenu();
        exportAgentSession(agent.id);
        break;

      case 'close':
        hideContextMenu();
        showConfirmDialog(`Close agent "${agent.name}"?`, () => {
          send({ type: 'destroy', id: agent.id });
        });
        break;
    }
  });
}

function startInlineRename(agent) {
  // Find the agent item in the sidebar and replace the name with an input
  const agentEl = document.querySelector(`.agent-item[data-agent-id="${agent.id}"]`);
  if (!agentEl) return;
  const nameEl = agentEl.querySelector('.agent-name');
  if (!nameEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'agent-rename-input';
  input.value = agent.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const finishRename = () => {
    const newName = input.value.trim();
    if (newName && newName !== agent.name) {
      agent.name = newName;
      showToast(`Agent renamed to "${newName}"`, 'info');
      addActivity('\u270F', `Agent renamed to "${newName}"`, 'info');
      // Update terminal header if this is the active agent
      if (agent.id === activeAgentId) {
        updateTerminalHeader(agent);
        showFloatingInput(agent);
      }
    }
    renderSidebar();
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      input.value = agent.name; // Reset
      input.blur();
    }
  });
}

// ═══════════════════════════════════════════
// Cycle 7: Inline Sticky Note Editor
// ═══════════════════════════════════════════

function startInlineNote(agent) {
  const agentEl = document.querySelector(`.agent-item[data-agent-id="${agent.id}"]`);
  if (!agentEl) return;
  const details = agentEl.querySelector('.agent-details');
  if (!details) return;

  // Remove existing note element if present
  const existingNote = details.querySelector('.agent-note');
  if (existingNote) existingNote.remove();

  // Remove existing editor if present
  const existingEditor = details.querySelector('.agent-note-editor');
  if (existingEditor) existingEditor.remove();

  const notes = getAgentNotes();
  const currentNote = notes[agent.id] || '';

  const textarea = document.createElement('textarea');
  textarea.className = 'agent-note-editor';
  textarea.placeholder = 'Add a note...';
  textarea.value = currentNote;
  textarea.maxLength = 200;
  textarea.rows = 2;
  details.appendChild(textarea);
  textarea.focus();

  const finishNote = () => {
    const newNote = textarea.value.trim();
    saveAgentNote(agent.id, newNote);
    if (newNote) {
      showToast('Note saved', 'info');
    } else {
      showToast('Note removed', 'info');
    }
    renderSidebar();
  };

  textarea.addEventListener('blur', finishNote);
  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textarea.blur(); }
    if (e.key === 'Escape') {
      textarea.value = currentNote; // Reset
      textarea.blur();
    }
  });
}

// ═══════════════════════════════════════════
// Resizable Panels
// ═══════════════════════════════════════════

function initResizablePanels() {
  const sidebar = $('#sidebar');
  const previewPanel = $('#preview-panel');
  const workspace = $('#workspace');

  // Apply saved widths
  sidebar.style.width = sidebarWidth + 'px';
  previewPanel.style.width = previewWidth + 'px';

  // Create sidebar resize handle
  const sidebarHandle = document.createElement('div');
  sidebarHandle.className = 'resize-handle';
  sidebarHandle.id = 'sidebar-resize-handle';
  workspace.insertBefore(sidebarHandle, sidebar.nextSibling);

  // Create preview resize handle (inserted before preview panel)
  const previewHandle = document.createElement('div');
  previewHandle.className = 'resize-handle';
  previewHandle.id = 'preview-resize-handle';
  workspace.insertBefore(previewHandle, previewPanel);

  // Sidebar drag
  sidebarHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    dragTarget = 'sidebar';
    dragStartX = e.clientX;
    dragStartWidth = sidebar.offsetWidth;
    sidebarHandle.classList.add('dragging');
    document.body.classList.add('resizing');
  });

  // Preview drag
  previewHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    dragTarget = 'preview';
    dragStartX = e.clientX;
    dragStartWidth = previewPanel.offsetWidth;
    previewHandle.classList.add('dragging');
    document.body.classList.add('resizing');
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    e.preventDefault();

    if (dragTarget === 'sidebar') {
      const delta = e.clientX - dragStartX;
      const newWidth = Math.min(500, Math.max(180, dragStartWidth + delta));
      sidebar.style.width = newWidth + 'px';
      sidebarWidth = newWidth;
    } else if (dragTarget === 'preview') {
      // Preview panel: dragging left makes it wider, dragging right makes it narrower
      const delta = dragStartX - e.clientX;
      const newWidth = Math.min(500, Math.max(180, dragStartWidth + delta));
      previewPanel.style.width = newWidth + 'px';
      previewWidth = newWidth;
    }

    refitActiveTerminal();
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    document.body.classList.remove('resizing');

    const handles = $$('.resize-handle');
    for (const h of handles) h.classList.remove('dragging');

    // Save to localStorage
    if (dragTarget === 'sidebar') {
      localStorage.setItem('nexus-sidebar-width', sidebarWidth);
    } else if (dragTarget === 'preview') {
      localStorage.setItem('nexus-preview-width', previewWidth);
    }
    dragTarget = null;
    refitActiveTerminal();
  });
}

// ═══════════════════════════════════════════
// Shortcut Overlay
// ═══════════════════════════════════════════

function toggleShortcutOverlay() {
  shortcutOverlayVisible = !shortcutOverlayVisible;
  const overlay = $('#shortcut-overlay');
  if (overlay) {
    overlay.classList.toggle('hidden', !shortcutOverlayVisible);
  }
}

function initShortcutOverlay() {
  const closeBtn = $('#btn-close-shortcuts');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      shortcutOverlayVisible = false;
      $('#shortcut-overlay').classList.add('hidden');
    });
  }

  const overlay = $('#shortcut-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        shortcutOverlayVisible = false;
        overlay.classList.add('hidden');
      }
    });
  }
}

// ═══════════════════════════════════════════
// Workspace Presets
// ═══════════════════════════════════════════

function saveWorkspace() {
  if (agents.size === 0) {
    showToast('No agents to save', 'error');
    return;
  }

  const overlay = $('#workspace-name-overlay');
  const input = $('#workspace-name-input');
  const cancelBtn = $('#workspace-name-cancel');
  const okBtn = $('#workspace-name-ok');

  overlay.classList.remove('hidden');
  input.value = '';
  setTimeout(() => input.focus(), 80);

  const close = () => overlay.classList.add('hidden');

  const doSave = () => {
    const name = input.value.trim();
    if (!name) {
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 400);
      return;
    }
    close();

    const agentList = [];
    for (const a of agents.values()) {
      agentList.push({ name: a.name, cwd: a.cwd, command: a.command || 'claude' });
    }

    fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, agents: agentList }),
    })
    .then(r => {
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      return r.json();
    })
    .then(data => {
      showToast(`Workspace "${name}" saved (${agentList.length} agents)`, 'success');
      addActivity('\uD83D\uDCBE', `Workspace "${name}" saved`, 'success');
    })
    .catch(err => showToast(`Save error: ${err.message}`, 'error'));
  };

  // Clone to clear old listeners
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
  const newOk = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);

  newCancel.addEventListener('click', close);
  newOk.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { close(); }
    e.stopPropagation();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

function loadWorkspaceMenu() {
  const dropdown = $('#workspace-dropdown');
  if (!dropdown) return;

  // Toggle visibility
  if (!dropdown.classList.contains('hidden')) {
    dropdown.classList.add('hidden');
    return;
  }

  dropdown.innerHTML = '<div class="workspace-loading">Loading...</div>';
  dropdown.classList.remove('hidden');

  // Position below the Load button
  const btn = $('#btn-load-workspace');
  const rect = btn.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.right = `${window.innerWidth - rect.right}px`;

  fetch('/api/workspaces')
    .then(r => {
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      return r.json();
    })
    .then(raw => {
      // Handle both array format and {ok, workspaces} format
      const workspaces = Array.isArray(raw) ? raw : (raw.workspaces || []);
      if (workspaces.length === 0) {
        dropdown.innerHTML = '<div class="workspace-empty">No saved workspaces</div>';
        return;
      }

      dropdown.innerHTML = workspaces.map(w => `
        <div class="workspace-item" data-name="${escapeAttr(w.name)}">
          <div class="workspace-item-info">
            <span class="workspace-item-name">${escapeHtml(w.name)}</span>
            <span class="workspace-item-count">${w.agents.length} agent${w.agents.length !== 1 ? 's' : ''}</span>
          </div>
          <button class="btn btn-icon-only btn-small workspace-delete" data-name="${escapeAttr(w.name)}" title="Delete workspace">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
              <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
            </svg>
          </button>
        </div>
      `).join('');

      // Bind click handlers
      for (const item of dropdown.querySelectorAll('.workspace-item')) {
        item.addEventListener('click', (e) => {
          if (e.target.closest('.workspace-delete')) return;
          loadWorkspace(item.dataset.name, workspaces);
          dropdown.classList.add('hidden');
        });
      }

      for (const delBtn of dropdown.querySelectorAll('.workspace-delete')) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const name = delBtn.dataset.name;
          showConfirmDialog(`Delete workspace "${name}"?`, () => {
            fetch(`/api/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE' })
              .then(r => r.json())
              .then(() => {
                showToast(`Workspace "${name}" deleted`, 'success');
                dropdown.classList.add('hidden');
              })
              .catch(err => showToast(err.message, 'error'));
          });
        });
      }
    })
    .catch(err => {
      dropdown.innerHTML = `<div class="workspace-empty">Error: ${escapeHtml(err.message)}</div>`;
    });

  // Close dropdown when clicking outside
  const closeDropdown = (e) => {
    if (!dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      dropdown.classList.add('hidden');
      document.removeEventListener('click', closeDropdown);
    }
  };
  setTimeout(() => document.addEventListener('click', closeDropdown), 0);
}

function loadWorkspace(name, workspaces) {
  const ws = workspaces.find(w => w.name === name);
  if (!ws) return;

  for (const a of ws.agents) {
    send({ type: 'create', name: a.name, cwd: a.cwd, command: a.command || 'claude' });
  }
  showToast(`Loading workspace "${name}" (${ws.agents.length} agents)`, 'success');
  addActivity('\uD83D\uDCC2', `Workspace "${name}" loaded`, 'info');
}

// ═══════════════════════════════════════════
// Sidebar Tab Switching
// ═══════════════════════════════════════════

function initSidebarTabs() {
  const tabs = $$('.sidebar-tab');
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      // Deactivate all tabs and contents
      for (const t of tabs) t.classList.remove('active');
      for (const c of $$('.sidebar-tab-content')) c.classList.remove('active');

      // Activate clicked tab and its content
      tab.classList.add('active');
      const content = $(`#${tab.dataset.tab}`);
      if (content) content.classList.add('active');
    });
  }
}

// ═══════════════════════════════════════════
// Cycle 4: New Lines Indicator
// ═══════════════════════════════════════════

function showNewLinesIndicator(count) {
  hideNewLinesIndicator();
  const container = $('#terminal-container');
  if (!container) return;

  const indicator = document.createElement('div');
  indicator.id = 'new-lines-indicator';
  indicator.className = 'new-lines-indicator';
  indicator.innerHTML = `<span>${count} new lines since you last viewed</span>`;
  indicator.addEventListener('click', () => hideNewLinesIndicator());
  container.appendChild(indicator);

  // Auto-dismiss after 4 seconds
  setTimeout(() => hideNewLinesIndicator(), 4000);
}

function hideNewLinesIndicator() {
  const el = $('#new-lines-indicator');
  if (el) {
    el.classList.add('new-lines-out');
    setTimeout(() => el.remove(), 250);
  }
}

// ═══════════════════════════════════════════
// Cycle 4: Agent Status Summary Bar
// ═══════════════════════════════════════════

function renderStatusBar() {
  const bar = $('#status-bar');
  if (!bar) return;

  let active = 0, waiting = 0, exited = 0;
  for (const agent of agents.values()) {
    if (agent.status === 'active') active++;
    else if (agent.status === 'waiting') waiting++;
    else if (agent.status === 'exited') exited++;
  }

  const total = agents.size;
  if (total === 0) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');

  const chips = bar.querySelector('.status-chips');
  if (!chips) return;

  chips.innerHTML = `
    <button class="status-chip status-chip-total${statusFilter === null ? ' active' : ''}" data-filter="">
      <span class="status-chip-count">${total}</span>
      <span class="status-chip-label">Total</span>
    </button>
    <button class="status-chip status-chip-active${statusFilter === 'active' ? ' active' : ''}" data-filter="active">
      <span class="status-chip-dot" style="background:var(--color-success);box-shadow:0 0 6px var(--color-success-glow);"></span>
      <span class="status-chip-count">${active}</span>
      <span class="status-chip-label">Active</span>
    </button>
    ${waiting > 0 ? `
    <button class="status-chip status-chip-waiting${statusFilter === 'waiting' ? ' active' : ''}" data-filter="waiting">
      <span class="status-chip-dot" style="background:var(--color-warning);box-shadow:0 0 6px var(--color-warning-glow);"></span>
      <span class="status-chip-count">${waiting}</span>
      <span class="status-chip-label">Waiting</span>
    </button>` : ''}
    ${exited > 0 ? `
    <button class="status-chip status-chip-exited${statusFilter === 'exited' ? ' active' : ''}" data-filter="exited">
      <span class="status-chip-dot" style="background:var(--color-text-tertiary);opacity:0.5;"></span>
      <span class="status-chip-count">${exited}</span>
      <span class="status-chip-label">Exited</span>
    </button>` : ''}
  `;

  // Auto-reply global toggle
  const arToggle = bar.querySelector('#status-auto-reply');
  if (arToggle) {
    arToggle.classList.toggle('active', autoReplyGlobal);
  }

  // Bind chip click handlers
  for (const chip of chips.querySelectorAll('.status-chip')) {
    chip.addEventListener('click', () => {
      const f = chip.dataset.filter;
      statusFilter = f === '' ? null : (statusFilter === f ? null : f);
      renderStatusBar();
      renderSidebar();
    });
  }
}

// ═══════════════════════════════════════════
// Cycle 4: Filtered Agent List
// ═══════════════════════════════════════════

function getFilteredSortedAgents() {
  let all = getSortedAgents();
  if (statusFilter) {
    all = all.filter(a => a.status === statusFilter);
  }
  return all;
}

// ═══════════════════════════════════════════
// Cycle 4: Command Palette (Cmd+K)
// ═══════════════════════════════════════════

function openCommandPalette() {
  if (commandPaletteVisible) { closeCommandPalette(); return; }
  commandPaletteVisible = true;

  const overlay = $('#command-palette-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    const input = overlay.querySelector('.palette-input');
    if (input) {
      input.value = '';
      input.focus();
    }
    renderPaletteResults('');
  }
}

function closeCommandPalette() {
  commandPaletteVisible = false;
  const overlay = $('#command-palette-overlay');
  if (overlay) overlay.classList.add('hidden');
  // Return focus to terminal
  if (activeAgentId) {
    const agent = agents.get(activeAgentId);
    if (agent) agent.terminal.focus();
  }
}

function getPaletteItems() {
  const items = [];

  // Agent items
  for (const agent of agents.values()) {
    items.push({
      id: `switch-${agent.id}`,
      type: 'agent',
      label: agent.name,
      detail: shortenPath(agent.cwd),
      status: agent.status,
      action: () => { switchToAgent(agent.id); },
    });
  }

  // Actions
  items.push({ id: 'action-new', type: 'action', label: 'New Agent', detail: 'Create a new agent', icon: '+', action: () => { openModal(); } });
  items.push({ id: 'action-mute', type: 'action', label: soundMuted ? 'Unmute Notifications' : 'Mute Notifications', detail: 'Toggle sound', icon: soundMuted ? '\u{1F508}' : '\u{1F50A}', action: () => { toggleMute(); } });
  items.push({ id: 'action-preview', type: 'action', label: 'Toggle File Browser', detail: 'Show or hide file panel', icon: '\u{1F4C2}', action: () => { togglePreview(); } });
  items.push({ id: 'action-shortcuts', type: 'action', label: 'Keyboard Shortcuts', detail: 'Show shortcut reference', icon: '?', action: () => { toggleShortcutOverlay(); } });
  items.push({ id: 'action-mcp', type: 'action', label: 'Manage MCP Servers', detail: 'Add, remove, or view MCP server configurations', icon: '\u2699', action: () => { openMcpManager(); } });
  items.push({ id: 'action-focus', type: 'action', label: focusModeActive ? 'Exit Focus Mode' : 'Enter Focus Mode', detail: 'Hide sidebar and status bar for distraction-free work', icon: '\u2726', action: () => { toggleFocusMode(); } });
  items.push({
    id: 'action-auto-reply',
    type: 'action',
    label: autoReplyGlobal ? 'Disable Auto-Reply (Global)' : 'Enable Auto-Reply (Global)',
    detail: 'Auto-send "y" to all permission prompts',
    icon: '\u{26A1}',
    action: () => { toggleAutoReplyGlobal(); },
  });

  // Active agent actions
  if (activeAgentId) {
    const active = agents.get(activeAgentId);
    if (active) {
      items.push({ id: 'action-restart', type: 'action', label: `Restart "${active.name}"`, detail: 'Kill and restart current agent', icon: '\u{21BB}', action: () => {
        const { name, cwd, command } = active;
        pendingRestarts.set(active.id, { name, cwd, command: command || 'claude' });
        send({ type: 'destroy', id: active.id });
      }});
      items.push({ id: 'action-close', type: 'action', label: `Close "${active.name}"`, detail: 'Destroy current agent', icon: '\u{2715}', action: () => {
        send({ type: 'destroy', id: active.id });
      }});
    }
  }

  // Workspace items
  // (will be populated async, but for now add a placeholder)
  items.push({ id: 'action-save-ws', type: 'action', label: 'Save Workspace', detail: 'Save current agents as a preset', icon: '\u{1F4BE}', action: () => { saveWorkspace(); } });
  items.push({ id: 'action-load-ws', type: 'action', label: 'Load Workspace', detail: 'Load a saved workspace preset', icon: '\u{1F4C1}', action: () => { loadWorkspaceMenu(); } });

  // Cycle 5: Cross-agent search
  items.push({ id: 'action-search-all', type: 'action', label: 'Search All Agents', detail: 'Search across all agent terminals', icon: '\u{1F50D}', action: () => { openCrossAgentSearch(); } });

  // Cycle 5: Export session
  if (activeAgentId) {
    items.push({ id: 'action-export', type: 'action', label: 'Export Session to Markdown', detail: 'Download terminal content as .md file', icon: '\u{1F4E4}', action: () => { exportAgentSession(activeAgentId); } });
  }

  // Cycle 5: Select all agents
  if (agents.size > 1) {
    items.push({ id: 'action-select-all', type: 'action', label: 'Select All Agents', detail: 'Multi-select all agents for batch commands', icon: '\u{2611}', action: () => { selectAllAgents(); } });
  }

  // Cycle 5: Snippets in command palette
  const snippets = getSnippets();
  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i];
    items.push({
      id: `snippet-${i}`,
      type: 'action',
      label: `Snippet: ${snippet.name}`,
      detail: snippet.text,
      icon: '\u{26A1}',
      action: () => {
        const input = $('#floating-input-field');
        if (input) {
          input.value = snippet.text;
          input.focus();
        }
      },
    });
  }

  return items;
}

function fuzzyMatch(query, text) {
  if (!query) return true;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function renderPaletteResults(query) {
  const list = $('#palette-results');
  if (!list) return;

  const items = getPaletteItems().filter(item =>
    fuzzyMatch(query, item.label) || fuzzyMatch(query, item.detail || '')
  );

  if (items.length === 0) {
    list.innerHTML = '<div class="palette-empty">No results found</div>';
    return;
  }

  list.innerHTML = items.map((item, i) => {
    const statusDot = item.type === 'agent'
      ? `<span class="palette-status-dot status-${item.status}"></span>`
      : `<span class="palette-action-icon">${item.icon || '\u25C6'}</span>`;
    const activeClass = i === 0 ? ' palette-item-active' : '';
    return `<div class="palette-item${activeClass}" data-index="${i}">
      ${statusDot}
      <div class="palette-item-text">
        <span class="palette-item-label">${escapeHtml(item.label)}</span>
        <span class="palette-item-detail">${escapeHtml(item.detail || '')}</span>
      </div>
      <span class="palette-item-type">${item.type === 'agent' ? 'Agent' : 'Action'}</span>
    </div>`;
  }).join('');

  // Store items reference for selection
  list._items = items;
  list._activeIndex = 0;

  // Bind click handlers
  for (const el of list.querySelectorAll('.palette-item')) {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index);
      if (items[idx]) {
        closeCommandPalette();
        items[idx].action();
      }
    });
    el.addEventListener('mouseenter', () => {
      for (const other of list.querySelectorAll('.palette-item')) {
        other.classList.remove('palette-item-active');
      }
      el.classList.add('palette-item-active');
      list._activeIndex = parseInt(el.dataset.index);
    });
  }
}

function navigatePalette(direction) {
  const list = $('#palette-results');
  if (!list || !list._items) return;

  const items = list.querySelectorAll('.palette-item');
  if (items.length === 0) return;

  let idx = list._activeIndex + direction;
  if (idx < 0) idx = items.length - 1;
  if (idx >= items.length) idx = 0;

  for (const el of items) el.classList.remove('palette-item-active');
  items[idx].classList.add('palette-item-active');
  items[idx].scrollIntoView({ block: 'nearest' });
  list._activeIndex = idx;
}

function selectPaletteItem() {
  const list = $('#palette-results');
  if (!list || !list._items) return;

  const items = list._items;
  const idx = list._activeIndex;
  if (items[idx]) {
    closeCommandPalette();
    items[idx].action();
  }
}

// ═══════════════════════════════════════════
// Cycle 4: Auto-Reply
// ═══════════════════════════════════════════

function toggleAutoReplyGlobal() {
  autoReplyGlobal = !autoReplyGlobal;
  localStorage.setItem('nexus-auto-reply-global', autoReplyGlobal ? '1' : '0');
  renderStatusBar();
  showToast(autoReplyGlobal ? 'Auto-reply enabled (all agents)' : 'Auto-reply disabled', autoReplyGlobal ? 'success' : 'info');
  addActivity('\u26A1', autoReplyGlobal ? 'Auto-reply enabled globally' : 'Auto-reply disabled globally', 'info');
}

function toggleAutoReplyAgent(agentId) {
  if (autoReplyAgents.has(agentId)) {
    autoReplyAgents.delete(agentId);
  } else {
    autoReplyAgents.add(agentId);
  }
  localStorage.setItem('nexus-auto-reply-agents', JSON.stringify(Array.from(autoReplyAgents)));
  const agent = agents.get(agentId);
  const name = agent ? agent.name : agentId;
  const enabled = autoReplyAgents.has(agentId);
  showToast(enabled ? `Auto-reply enabled for "${name}"` : `Auto-reply disabled for "${name}"`, 'info');
  addActivity('\u26A1', `Auto-reply ${enabled ? 'enabled' : 'disabled'} for "${name}"`, 'info');
}

// ═══════════════════════════════════════════
// Cycle 7: Favicon Badge
// ═══════════════════════════════════════════

function updateFaviconBadge(showBadge) {
  if (faviconBadgeActive === showBadge) return;
  faviconBadgeActive = showBadge;

  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;

  if (!showBadge) {
    link.href = ORIGINAL_FAVICON;
    return;
  }

  // Draw notification dot on favicon using canvas
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  // Draw base diamond icon
  ctx.fillStyle = '#818cf8';
  ctx.font = '52px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u25C6', 32, 30);

  // Draw notification dot
  ctx.beginPath();
  ctx.arc(52, 12, 10, 0, Math.PI * 2);
  ctx.fillStyle = '#ef4444';
  ctx.fill();
  ctx.strokeStyle = '#0a0a14';
  ctx.lineWidth = 2;
  ctx.stroke();

  link.href = canvas.toDataURL('image/png');
}

// ═══════════════════════════════════════════
// Cycle 7: Smooth Tab Title Rotation
// ═══════════════════════════════════════════

function getWaitingAgentNames() {
  const names = [];
  for (const agent of agents.values()) {
    if (agent.question) names.push(agent.name);
  }
  return names;
}

function startTabTitleRotation() {
  const waiting = getWaitingAgentNames();
  if (waiting.length === 0) {
    stopTabTitleRotation();
    document.title = 'Claude Nexus';
    return;
  }

  // Set initial title immediately
  tabTitleRotationIndex = tabTitleRotationIndex % waiting.length;
  document.title = `(${waiting.length}) ${waiting[tabTitleRotationIndex]} needs input`;

  // Only start interval if not already running
  if (tabTitleRotationInterval) return;
  tabTitleRotationInterval = setInterval(() => {
    const current = getWaitingAgentNames();
    if (current.length === 0) {
      stopTabTitleRotation();
      document.title = 'Claude Nexus';
      return;
    }
    tabTitleRotationIndex = (tabTitleRotationIndex + 1) % current.length;
    document.title = `(${current.length}) ${current[tabTitleRotationIndex]} needs input`;
  }, 3000);
  _intervals.add(tabTitleRotationInterval);
}

function stopTabTitleRotation() {
  if (tabTitleRotationInterval) {
    clearInterval(tabTitleRotationInterval);
    _intervals.delete(tabTitleRotationInterval);
    tabTitleRotationInterval = null;
  }
  tabTitleRotationIndex = 0;
}

// ═══════════════════════════════════════════
// Cycle 7: Quick Actions (Scroll to Bottom, Clear Terminal, Copy Last Output)
// ═══════════════════════════════════════════

function scrollTerminalToBottom() {
  if (!activeAgentId) return;
  const agent = agents.get(activeAgentId);
  if (!agent) return;
  agent.terminal.scrollToBottom();
  updateScrollToBottomButton(agent);
}

function clearTerminal() {
  if (!activeAgentId) return;
  const agent = agents.get(activeAgentId);
  if (!agent || agent.status === 'exited') return;
  // Send Ctrl+L to the PTY (form feed / clear screen)
  send({ type: 'input', id: activeAgentId, data: '\x0c' });
  showToast('Terminal cleared', 'info');
}

function copyLastOutput() {
  if (!activeAgentId) return;
  const agent = agents.get(activeAgentId);
  if (!agent) return;

  const buffer = agent.terminal.buffer.active;
  const lines = [];
  // Read last 50 non-empty lines from terminal buffer
  const startLine = Math.max(0, buffer.length - 50);
  for (let i = startLine; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }

  // Find the last non-empty block (trim trailing empty lines, then take last contiguous block)
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  const text = lines.join('\n').trim();
  if (!text) {
    showToast('No output to copy', 'info');
    return;
  }

  navigator.clipboard.writeText(text).then(() => {
    showToast('Output copied to clipboard', 'success');
  }).catch(() => {
    showToast('Failed to copy to clipboard', 'error');
  });
}

function updateScrollToBottomButton(agent) {
  const btn = $('#btn-scroll-bottom');
  if (!btn) return;

  if (!agent) {
    btn.classList.add('hidden');
    return;
  }

  const viewport = agent.container.querySelector('.xterm-viewport');
  if (!viewport) {
    btn.classList.add('hidden');
    return;
  }

  const isAtBottom = (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) < 30;
  btn.classList.toggle('hidden', isAtBottom);
}

function initScrollTracking() {
  // Use MutationObserver to detect when terminal instances are shown, then attach scroll listener
  const container = $('#terminal-container');
  if (!container) return;

  // Check scroll position whenever we switch agents or on scroll
  const observer = new MutationObserver(() => {
    if (!activeAgentId) return;
    const agent = agents.get(activeAgentId);
    if (!agent) return;

    // Attach scroll listener to the current terminal's viewport if not already done
    const viewport = agent.container.querySelector('.xterm-viewport');
    if (viewport && !viewport._nexusScrollBound) {
      viewport._nexusScrollBound = true;
      viewport.addEventListener('scroll', () => {
        updateScrollToBottomButton(agent);
      }, { passive: true });
    }
    updateScrollToBottomButton(agent);
  });

  observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
}

// ═══════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════

function init() {
  loadCmdHistory();
  connect();
  initSidebarTabs();
  initResizablePanels();
  initContextMenu();
  initShortcutOverlay();
  initCommandPalette();
  initStatusBar();
  initMcpManager();
  initFileDragDrop();
  initSnippets();
  initDirValidation();
  initRemoteAccess();
  updateMuteUI();
  startAutoSave();

  // Cycle 6: Elapsed timer refresh (every 30s)
  if (elapsedTimerInterval) { clearInterval(elapsedTimerInterval); _intervals.delete(elapsedTimerInterval); }
  elapsedTimerInterval = setInterval(() => {
    // Update sidebar elapsed times
    for (const el of $$('.agent-elapsed')) {
      const item = el.closest('.agent-item');
      if (!item) continue;
      const agentId = item.dataset.agentId;
      const agent = agents.get(agentId);
      if (agent && agent.startedAt) {
        el.textContent = formatElapsed(agent.startedAt);
      }
    }
    // Update terminal header timer
    if (activeAgentId) {
      const agent = agents.get(activeAgentId);
      if (agent) updateTerminalHeader(agent);
    }
    // Re-render sidebar to update idle states
    renderSidebar();
  }, 30000);
  _intervals.add(elapsedTimerInterval);

  // Preemptive UX: Away summary listener
  initAwaySummary();

  // Preemptive UX: Startup prompt toggle and presets
  initStartupPrompt();

  // Preemptive UX: Popover cleanup on body click
  document.addEventListener('click', (e) => {
    const popover = $('#agent-popover');
    if (popover && !popover.contains(e.target) && !e.target.closest('.agent-item')) {
      hideAgentPopover();
    }
  });

  // Cycle 5: Check for last workspace after a short delay (wait for WS connection)
  setTimeout(() => checkLastWorkspace(), 1500);

  // Hide preview resize handle initially (preview panel is hidden)
  const previewHandle = $('#preview-resize-handle');
  if (previewHandle) previewHandle.style.display = 'none';

  // ITEM 1: File split close button
  const closeSplitBtn = $('#btn-close-file-split');
  if (closeSplitBtn) closeSplitBtn.addEventListener('click', closeFileSplit);

  // ITEM 1: File split resizer (drag to resize)
  initFileSplitResizer();

  // ITEM 2: Quick action buttons
  initQuickActions();

  // ITEM 4: Session timer and heartbeat
  initSessionTimer();

  // Mute toggle button
  const muteBtn = $('#btn-mute-toggle');
  if (muteBtn) muteBtn.addEventListener('click', toggleMute);

  // Workspace buttons
  $('#btn-save-workspace').addEventListener('click', saveWorkspace);
  $('#btn-load-workspace').addEventListener('click', loadWorkspaceMenu);

  // Status bar palette hint trigger
  const paletteHint = $('#palette-hint-trigger');
  if (paletteHint) paletteHint.addEventListener('click', openCommandPalette);

  // Activity log clear button
  const clearBtn = $('#btn-clear-activity');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activityLog.length = 0;
      renderActivityLog();
    });
  }

  // New agent buttons
  $('#btn-new-agent').addEventListener('click', openModal);
  const emptyCreate = $('#btn-empty-create');
  if (emptyCreate) emptyCreate.addEventListener('click', openModal);

  // Terminal header actions
  $('#btn-toggle-preview').addEventListener('click', togglePreview);
  $('#btn-close-preview').addEventListener('click', togglePreview);

  $('#btn-preview-back').addEventListener('click', () => {
    if (previewHistory.length > 1) {
      previewHistory.pop();
      const prev = previewHistory.pop();
      browseFiles(prev);
    } else if (activeAgentId) {
      const agent = agents.get(activeAgentId);
      if (agent) browseFiles(agent.cwd);
    }
  });

  // Cycle 7: Quick Actions in terminal header
  const scrollBottomBtn = $('#btn-scroll-bottom');
  if (scrollBottomBtn) scrollBottomBtn.addEventListener('click', scrollTerminalToBottom);
  const clearTermBtn = $('#btn-clear-terminal');
  if (clearTermBtn) clearTermBtn.addEventListener('click', clearTerminal);
  const copyLastBtn = $('#btn-copy-last-output');
  if (copyLastBtn) copyLastBtn.addEventListener('click', copyLastOutput);

  // Copy Selection button in terminal header
  const copySelBtn = $('#btn-copy-selection');
  if (copySelBtn) {
    copySelBtn.addEventListener('click', () => {
      if (!activeAgentId) return;
      const agent = agents.get(activeAgentId);
      if (!agent) return;
      if (agent.terminal.hasSelection()) {
        const text = agent.terminal.getSelection();
        navigator.clipboard.writeText(text).then(() => {
          showToast('Copied to clipboard', 'info');
          agent.terminal.clearSelection();
        }).catch(() => {});
      } else {
        showToast('No text selected', 'info');
      }
    });
  }

  // Agent Switcher: click agent name in terminal header to open dropdown
  const agentNameEl = $('#terminal-agent-name');
  if (agentNameEl) {
    agentNameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (agentSwitcherVisible) {
        closeAgentSwitcher();
      } else {
        openAgentSwitcher();
      }
    });
  }

  // Cycle 7: Scroll-to-bottom tracking
  initScrollTracking();

  // Cycle 5: Export session button
  $('#btn-export-session').addEventListener('click', () => {
    if (activeAgentId) exportAgentSession(activeAgentId);
  });

  $('#btn-close-agent').addEventListener('click', () => {
    if (!activeAgentId) return;
    const agent = agents.get(activeAgentId);
    if (agent) {
      showConfirmDialog(`Close agent "${agent.name}"?`, () => {
        send({ type: 'destroy', id: agent.id });
      });
    }
  });

  $('#btn-restart-agent').addEventListener('click', () => {
    if (!activeAgentId) return;
    const agent = agents.get(activeAgentId);
    if (!agent) return;
    showConfirmDialog(`Restart agent "${agent.name}"?`, () => {
      const { name, cwd, command } = agent;
      pendingRestarts.set(agent.id, { name, cwd, command: command || 'claude' });
      send({ type: 'destroy', id: agent.id });
    });
  });

  // Modal buttons
  $('#btn-modal-close').addEventListener('click', closeModal);
  $('#btn-modal-cancel').addEventListener('click', closeModal);
  $('#btn-create-agent').addEventListener('click', handleCreateAgent);
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) closeModal();
  });

  // Modal form Enter navigation
  $('#agent-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#agent-cwd').focus(); }
  });
  $('#agent-cwd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleCreateAgent(); }
  });
  $('#agent-command').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleCreateAgent(); }
  });

  // Startup prompt textarea: stop propagation so global shortcuts don't fire
  const startupTextarea = $('#agent-startup-prompt');
  if (startupTextarea) {
    startupTextarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // Cmd+Enter submits the form
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleCreateAgent();
      }
    });
  }

  // Folder browser toggle in modal
  $('#btn-browse-folder').addEventListener('click', () => {
    const fb = $('#folder-browser');
    fb.classList.toggle('hidden');
    if (!fb.classList.contains('hidden')) {
      const currentVal = $('#agent-cwd').value.trim();
      if (currentVal) {
        browseFolders(currentVal);
      } else {
        // Show recent dirs first, then fall back to folder browser
        renderRecentDirs();
      }
    }
  });

  // Floating input bar
  const floatingInput = $('#floating-input-field');
  const floatingSend = $('#floating-input-send');
  if (floatingInput) {
    floatingInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Don't trigger global shortcuts
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // If autocomplete is visible, accept the highlighted suggestion
        const highlighted = $('#autocomplete-dropdown .autocomplete-item.highlighted');
        if (highlighted) {
          floatingInput.value = highlighted.dataset.text;
          closeAutocomplete();
          autoResizeTextarea(floatingInput);
          return;
        }
        sendFloatingInput();
      }
      // Shift+Enter: allow default behavior (inserts newline in textarea)
      if (e.key === 'Enter' && e.shiftKey) {
        // Let the browser insert the newline, then resize
        setTimeout(() => autoResizeTextarea(floatingInput), 0);
        return;
      }
      if (e.key === 'Tab') {
        // Accept first autocomplete suggestion if visible
        const firstItem = $('#autocomplete-dropdown .autocomplete-item');
        if (firstItem) {
          e.preventDefault();
          floatingInput.value = firstItem.dataset.text;
          closeAutocomplete();
          autoResizeTextarea(floatingInput);
          return;
        }
      }
      if (e.key === 'ArrowUp') {
        // If autocomplete is open, navigate it
        const acDropdown = $('#autocomplete-dropdown');
        if (acDropdown) {
          e.preventDefault();
          navigateAutocomplete(-1);
          return;
        }
        // Only navigate history if cursor is at the start (first line)
        const cursorPos = floatingInput.selectionStart;
        const textBefore = floatingInput.value.substring(0, cursorPos);
        if (textBefore.includes('\n')) return; // Let arrow move within textarea
        e.preventDefault();
        if (cmdHistory.length === 0) return;
        if (cmdHistoryIndex === -1) {
          // Save current draft
          cmdHistoryDraft = floatingInput.value;
          cmdHistoryIndex = 0;
        } else if (cmdHistoryIndex < cmdHistory.length - 1) {
          cmdHistoryIndex++;
        }
        floatingInput.value = cmdHistory[cmdHistoryIndex];
        autoResizeTextarea(floatingInput);
        // Move cursor to end
        floatingInput.setSelectionRange(floatingInput.value.length, floatingInput.value.length);
      }
      if (e.key === 'ArrowDown') {
        // If autocomplete is open, navigate it
        const acDropdown = $('#autocomplete-dropdown');
        if (acDropdown) {
          e.preventDefault();
          navigateAutocomplete(1);
          return;
        }
        // Only navigate history if cursor is at the end (last line)
        const cursorPos = floatingInput.selectionStart;
        const textAfter = floatingInput.value.substring(cursorPos);
        if (textAfter.includes('\n')) return; // Let arrow move within textarea
        if (cmdHistoryIndex === -1) return;
        e.preventDefault();
        if (cmdHistoryIndex > 0) {
          cmdHistoryIndex--;
          floatingInput.value = cmdHistory[cmdHistoryIndex];
        } else {
          // Restore draft
          cmdHistoryIndex = -1;
          floatingInput.value = cmdHistoryDraft;
        }
        autoResizeTextarea(floatingInput);
        floatingInput.setSelectionRange(floatingInput.value.length, floatingInput.value.length);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Dismiss autocomplete if visible
        const acDropdown = $('#autocomplete-dropdown');
        if (acDropdown) { closeAutocomplete(); return; }
        // If navigating history, restore draft
        if (cmdHistoryIndex !== -1) {
          cmdHistoryIndex = -1;
          floatingInput.value = cmdHistoryDraft;
          autoResizeTextarea(floatingInput);
          return;
        }
        // Dismiss paste warning if visible
        const pasteWarn = $('#paste-warning');
        if (pasteWarn) { pasteWarn.remove(); return; }
        // Return focus to terminal
        if (activeAgentId) {
          const agent = agents.get(activeAgentId);
          if (agent) agent.terminal.focus();
        }
      }
    });

    // UX Polish: Autocomplete suggestions from command history
    floatingInput.addEventListener('input', () => {
      // Reset history index when user types
      cmdHistoryIndex = -1;
      showAutocomplete(floatingInput.value);
      // Auto-resize textarea
      autoResizeTextarea(floatingInput);
    });

    // Multi-line paste: just allow it naturally into the textarea (no warning needed for textarea)
    // The textarea handles multi-line natively; just auto-resize after paste
    floatingInput.addEventListener('paste', () => {
      setTimeout(() => autoResizeTextarea(floatingInput), 0);
    });
  }
  if (floatingSend) {
    floatingSend.addEventListener('click', sendFloatingInput);
  }

  // Request notification permission on first interaction
  if ('Notification' in window && Notification.permission === 'default') {
    const req = () => { Notification.requestPermission(); document.removeEventListener('click', req); };
    document.addEventListener('click', req);
  }

  // Warn before closing tab if agents are running
  window.addEventListener('beforeunload', (e) => {
    const activeCount = Array.from(agents.values()).filter(a => a.status === 'active' || a.status === 'waiting').length;
    if (activeCount > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
    for (const id of _intervals) clearInterval(id);
    _intervals.clear();
    stopTabTitleRotation();
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
}

function initCommandPalette() {
  const overlay = $('#command-palette-overlay');
  if (!overlay) return;

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCommandPalette();
  });

  // Input handling
  const input = overlay.querySelector('.palette-input');
  if (input) {
    input.addEventListener('input', () => {
      renderPaletteResults(input.value);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') { e.preventDefault(); navigatePalette(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigatePalette(-1); }
      if (e.key === 'Enter') { e.preventDefault(); selectPaletteItem(); }
      if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); }
    });
  }
}

function initStatusBar() {
  const bar = $('#status-bar');
  if (!bar) return;

  // Auto-reply global toggle
  const arBtn = bar.querySelector('#status-auto-reply');
  if (arBtn) {
    arBtn.addEventListener('click', () => {
      toggleAutoReplyGlobal();
    });
  }

  renderStatusBar();
}

function initFileDragDrop() {
  // Make file entries draggable and allow dropping on floating input
  const previewContent = $('#preview-content');
  const floatingField = $('#floating-input-field');
  if (!floatingField) return;

  // Delegate dragstart on file entries
  if (previewContent) {
    previewContent.addEventListener('dragstart', (e) => {
      const entry = e.target.closest('.file-entry');
      if (entry && entry.dataset.path) {
        e.dataTransfer.setData('text/plain', entry.dataset.path);
        e.dataTransfer.effectAllowed = 'copy';
      }
    });
  }

  // Accept drops on the floating input
  floatingField.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    floatingField.classList.add('drop-highlight');
  });

  floatingField.addEventListener('dragleave', () => {
    floatingField.classList.remove('drop-highlight');
  });

  floatingField.addEventListener('drop', (e) => {
    e.preventDefault();
    floatingField.classList.remove('drop-highlight');
    const path = e.dataTransfer.getData('text/plain');
    if (path) {
      // Insert path at cursor position or append
      const start = floatingField.selectionStart;
      const end = floatingField.selectionEnd;
      const before = floatingField.value.substring(0, start);
      const after = floatingField.value.substring(end);
      floatingField.value = before + path + after;
      floatingField.focus();
      floatingField.setSelectionRange(start + path.length, start + path.length);
    }
  });
}

function renderRecentDirs() {
  const dirs = getRecentDirs();
  const el = $('#folder-browser');
  const home = os_homedir();

  // No recent dirs? Just start browsing from home
  if (dirs.length === 0) {
    browseFolders(home);
    return;
  }

  let html = '';

  // General agent option (root access)
  html += '<div class="folder-select-btn" data-path="/" style="margin:8px 6px 4px;">General Agent (full computer access)</div>';

  // Recent directories - click to select immediately
  html += '<div class="folder-section-label">Recent</div>';
  for (const dir of dirs) {
    html += '<div class="folder-entry folder-recent" data-path="' + escapeAttr(dir) + '" data-action="select">' + escapeHtml(shortenPath(dir)) + '</div>';
  }

  // Browse buttons - click to navigate
  html += '<div class="folder-section-label" style="margin-top:4px;border-top:1px solid var(--color-border);padding-top:6px;">Or browse to find a folder</div>';
  html += '<div class="folder-entry folder-dir" data-path="' + escapeAttr(home) + '" data-action="browse">\uD83D\uDCC1 Home (' + escapeHtml(shortenPath(home)) + ')</div>';
  html += '<div class="folder-entry folder-dir" data-path="/Users" data-action="browse">\uD83D\uDCC1 /Users</div>';
  html += '<div class="folder-entry folder-dir" data-path="/" data-action="browse">\uD83D\uDCC1 / (root)</div>';

  el.innerHTML = html;

  // General agent button
  var selectBtn = el.querySelector('.folder-select-btn');
  if (selectBtn) {
    selectBtn.addEventListener('click', function() {
      $('#agent-cwd').value = '/';
      el.classList.add('hidden');
    });
  }

  // Handle entries
  var entries = el.querySelectorAll('.folder-entry');
  for (var i = 0; i < entries.length; i++) {
    entries[i].addEventListener('click', function() {
      var action = this.dataset.action;
      var p = this.dataset.path;
      if (action === 'browse') {
        browseFolders(p);
      } else {
        // Select immediately
        $('#agent-cwd').value = p;
        el.classList.add('hidden');
      }
    });
  }
}

// Best-effort home directory for the browser
function os_homedir() {
  // Extract from any known agent's cwd, or fall back to /Users
  for (const agent of agents.values()) {
    const match = agent.cwd.match(/^(\/Users\/[^/]+)/);
    if (match) return match[1];
  }
  return '/Users';
}

// ═══════════════════════════════════════════
// Cycle 6: Smart Paste Warning (Item 2)
// ═══════════════════════════════════════════

function showPasteWarning(pastedText) {
  // Remove existing warning
  const existing = $('#paste-warning');
  if (existing) existing.remove();

  const lineCount = pastedText.split('\n').length;
  const bar = $('#floating-input');
  if (!bar) return;

  const warn = document.createElement('div');
  warn.id = 'paste-warning';
  warn.className = 'paste-warning';
  warn.innerHTML = `
    <span class="paste-warning-text">Multi-line paste detected (${lineCount} lines). Send as single message?</span>
    <div class="paste-warning-actions">
      <button class="btn btn-primary btn-small paste-send">Send</button>
      <button class="btn btn-ghost btn-small paste-cancel">Cancel</button>
    </div>
  `;
  bar.querySelector('.floating-input-inner').appendChild(warn);

  warn.querySelector('.paste-send').addEventListener('click', () => {
    const input = $('#floating-input-field');
    // Replace newlines with escaped version for single-line send
    const cleaned = pastedText.replace(/\n/g, ' ');
    if (input) input.value = cleaned;
    warn.remove();
    sendFloatingInput();
  });

  warn.querySelector('.paste-cancel').addEventListener('click', () => {
    warn.remove();
    const input = $('#floating-input-field');
    if (input) input.focus();
  });
}

// ═══════════════════════════════════════════
// Cycle 6: Inline Directory Validation (Item 6)
// ═══════════════════════════════════════════

let dirValidationTimeout = null;

function initDirValidation() {
  const cwdInput = $('#agent-cwd');
  if (!cwdInput) return;

  cwdInput.addEventListener('input', () => {
    if (dirValidationTimeout) clearTimeout(dirValidationTimeout);
    const val = cwdInput.value.trim();
    if (!val) {
      cwdInput.classList.remove('input-valid', 'input-invalid');
      removeDirValidationMsg();
      return;
    }
    dirValidationTimeout = setTimeout(() => {
      fetch(`/api/validate-dir?path=${encodeURIComponent(val)}`)
        .then(r => r.json())
        .then(data => {
          if (data.valid) {
            cwdInput.classList.remove('input-invalid');
            cwdInput.classList.add('input-valid');
            removeDirValidationMsg();
          } else {
            cwdInput.classList.remove('input-valid');
            cwdInput.classList.add('input-invalid');
            showDirValidationMsg(data.error || 'Invalid directory');
          }
        })
        .catch(() => {
          cwdInput.classList.remove('input-valid', 'input-invalid');
        });
    }, 400);
  });
}

function showDirValidationMsg(msg) {
  removeDirValidationMsg();
  const group = $('#agent-cwd').closest('.form-group');
  if (!group) return;
  const el = document.createElement('div');
  el.id = 'dir-validation-msg';
  el.className = 'form-validation-error';
  el.textContent = msg;
  group.appendChild(el);
}

function removeDirValidationMsg() {
  const el = $('#dir-validation-msg');
  if (el) el.remove();
}

// ═══════════════════════════════════════════
// Cycle 6: localStorage Guard (Item 6)
// ═══════════════════════════════════════════

const _origSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function(key, value) {
  try {
    _origSetItem(key, value);
  } catch (e) {
    console.warn('localStorage full, clearing old Nexus data:', e.message);
    // Remove non-essential cached data
    try {
      localStorage.removeItem('nexus-last-workspace');
      localStorage.removeItem(SNIPPETS_KEY);
      _origSetItem(key, value);
    } catch {
      // Silently fail; app continues without persistence
    }
  }
};

// ═══════════════════════════════════════════
// Cycle 5: Snippets Initialization
// ═══════════════════════════════════════════

function initSnippets() {
  // Initialize default snippets if none exist
  if (!localStorage.getItem(SNIPPETS_KEY)) {
    saveSnippets(DEFAULT_SNIPPETS);
  }

  // Add snippets button to floating input
  const floatingRow = document.querySelector('.floating-input-row');
  if (floatingRow) {
    const snippetBtn = document.createElement('button');
    snippetBtn.id = 'btn-snippets';
    snippetBtn.className = 'btn btn-ghost btn-small btn-snippets';
    snippetBtn.title = 'Quick prompts';
    snippetBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2h7l3 3v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M4 8h6M4 10.5h4"/></svg>`;
    floatingRow.insertBefore(snippetBtn, floatingRow.firstChild);
    snippetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSnippetsDropdown();
    });
  }

  // Add "Save as Snippet" on right-click of floating input
  const floatingField = $('#floating-input-field');
  if (floatingField) {
    floatingField.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const text = floatingField.value.trim();
      if (text) {
        // Show a mini context menu
        showSnippetContextMenu(e, text);
      }
    });
  }
}

function showSnippetContextMenu(e, text) {
  // Remove existing
  const existing = $('#snippet-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'snippet-context-menu';
  menu.className = 'context-menu';
  menu.innerHTML = `
    <div class="context-menu-item" data-action="save-snippet">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2h7l3 3v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M4 8h6M4 10.5h4"/></svg>
      <span>Save as Snippet</span>
    </div>
  `;

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  menu.querySelector('[data-action="save-snippet"]').addEventListener('click', () => {
    const snippets = getSnippets();
    snippets.push({ name: text.substring(0, 30), text });
    saveSnippets(snippets);
    showToast('Snippet saved', 'success');
    menu.remove();
  });

  const closeMenu = (evt) => {
    if (!menu.contains(evt.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// ═══════════════════════════════════════════
// Cycle 5: Export button in terminal header
// ═══════════════════════════════════════════

// Add Cmd+A for select all (when not in input)
// and update keyboard shortcuts

// ═══════════════════════════════════════════
// Preemptive UX: Startup Prompt Init
// ═══════════════════════════════════════════

function initStartupPrompt() {
  const toggle = $('#startup-prompt-toggle');
  const section = $('#startup-prompt-section');
  if (!toggle || !section) return;

  toggle.addEventListener('click', () => {
    section.classList.toggle('collapsed');
    const chevron = toggle.querySelector('.startup-chevron');
    if (chevron) chevron.classList.toggle('expanded', !section.classList.contains('collapsed'));
    if (!section.classList.contains('collapsed')) {
      const textarea = $('#agent-startup-prompt');
      if (textarea) textarea.focus();
    }
  });

  // Load last used prompt
  const lastPrompt = localStorage.getItem(STARTUP_PROMPT_KEY) || '';

  // Preset buttons
  const presetContainer = $('#startup-presets');
  if (presetContainer) {
    const presets = [
      { label: 'Review codebase', text: 'Review the codebase and summarize what you find' },
      { label: 'Continue', text: 'Continue where you left off' },
      { label: 'Run tests', text: 'Run the tests and fix any failures' },
    ];

    if (lastPrompt) {
      presets.unshift({ label: 'Last used', text: lastPrompt });
    }

    presetContainer.innerHTML = presets.map(p =>
      `<button class="btn btn-ghost btn-small startup-preset" data-text="${escapeAttr(p.text)}">${escapeHtml(p.label)}</button>`
    ).join('');

    for (const btn of presetContainer.querySelectorAll('.startup-preset')) {
      btn.addEventListener('click', () => {
        const textarea = $('#agent-startup-prompt');
        if (textarea) {
          textarea.value = btn.dataset.text;
          textarea.focus();
        }
      });
    }
  }
}

// ═══════════════════════════════════════════
// MCP Server Manager
// ═══════════════════════════════════════════

function openMcpManager() {
  if (mcpManagerVisible) { closeMcpManager(); return; }
  mcpManagerVisible = true;
  const overlay = $('#mcp-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    loadMcpServers();
  }
}

function closeMcpManager() {
  mcpManagerVisible = false;
  const overlay = $('#mcp-overlay');
  if (overlay) overlay.classList.add('hidden');
  // Hide add form
  const addForm = $('#mcp-add-form');
  if (addForm) addForm.classList.add('hidden');
  // Return focus to terminal
  if (activeAgentId) {
    const agent = agents.get(activeAgentId);
    if (agent) agent.terminal.focus();
  }
}

function maskEnvValue(value) {
  if (!value || value.length <= 4) return '****';
  return value.substring(0, 4) + '...';
}

function getServerType(config) {
  if (config.transport === 'http' || config.transport === 'streamable-http' || config.url) {
    return 'http';
  }
  return 'stdio';
}

function getServerDetail(config) {
  const type = getServerType(config);
  if (type === 'http') {
    return config.url || 'No URL configured';
  }
  const cmd = config.command || '';
  const args = Array.isArray(config.args) ? config.args.join(' ') : '';
  return args ? `${cmd} ${args}` : cmd;
}

async function loadMcpServers() {
  const list = $('#mcp-server-list');
  if (!list) return;

  list.innerHTML = '<div class="mcp-loading">Loading servers...</div>';

  try {
    const res = await fetch('/api/mcp-servers');
    if (!res.ok) throw new Error('Failed to load');
    const servers = await res.json();
    renderMcpServers(servers);
  } catch (err) {
    list.innerHTML = '<div class="mcp-loading">Failed to load MCP servers</div>';
  }
}

function renderMcpServers(servers) {
  const list = $('#mcp-server-list');
  if (!list) return;

  const names = Object.keys(servers);
  if (names.length === 0) {
    list.innerHTML = `<div class="mcp-empty">
      <span class="mcp-empty-icon">&#9881;</span>
      No MCP servers configured
    </div>`;
    return;
  }

  list.innerHTML = names.map(name => {
    const config = servers[name];
    const type = getServerType(config);
    const detail = getServerDetail(config);
    const badgeClass = type === 'stdio' ? 'mcp-badge-stdio' : 'mcp-badge-http';
    const badgeLabel = type === 'stdio' ? 'stdio' : 'http';

    // Env vars section
    let envHtml = '';
    if (config.env && Object.keys(config.env).length > 0) {
      const envEntries = Object.entries(config.env);
      envHtml = `
        <button class="mcp-env-toggle" data-server="${escapeAttr(name)}">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 1l3 3-3 3"/></svg>
          ${envEntries.length} env variable${envEntries.length !== 1 ? 's' : ''}
        </button>
        <div class="mcp-env-list" data-env-for="${escapeAttr(name)}">
          ${envEntries.map(([k, v]) => `
            <div class="mcp-env-item">
              <span class="mcp-env-key">${escapeHtml(k)}:</span>
              <span class="mcp-env-value">${escapeHtml(maskEnvValue(String(v)))}</span>
            </div>
          `).join('')}
        </div>
      `;
    }

    return `<div class="mcp-server-card" data-server-name="${escapeAttr(name)}">
      <div class="mcp-server-header">
        <span class="mcp-server-name">${escapeHtml(name)}</span>
        <span class="mcp-badge ${badgeClass}">${badgeLabel}</span>
        <button class="mcp-server-delete" data-delete="${escapeAttr(name)}" title="Remove server">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="2" y1="2" x2="10" y2="10"/>
            <line x1="10" y1="2" x2="2" y2="10"/>
          </svg>
        </button>
      </div>
      <div class="mcp-server-detail" title="${escapeAttr(detail)}">${escapeHtml(detail)}</div>
      ${envHtml}
    </div>`;
  }).join('');

  // Bind env toggle clicks
  for (const btn of list.querySelectorAll('.mcp-env-toggle')) {
    btn.addEventListener('click', () => {
      const serverName = btn.dataset.server;
      const envList = list.querySelector(`.mcp-env-list[data-env-for="${serverName}"]`);
      if (envList) {
        envList.classList.toggle('visible');
        btn.classList.toggle('expanded');
      }
    });
  }

  // Bind delete buttons
  for (const btn of list.querySelectorAll('.mcp-server-delete')) {
    btn.addEventListener('click', () => {
      const serverName = btn.dataset.delete;
      showConfirmDialog(`Remove MCP server "${serverName}"?`, async () => {
        try {
          const res = await fetch(`/api/mcp-servers/${encodeURIComponent(serverName)}`, { method: 'DELETE' });
          if (!res.ok) throw new Error('Failed to delete');
          const data = await res.json();
          renderMcpServers(data.servers);
          showToast(`Removed "${serverName}"`, 'info');
        } catch (err) {
          showToast('Failed to remove server', 'info');
        }
      });
    });
  }
}

async function addMcpServer() {
  const nameInput = $('#mcp-server-name');
  const name = nameInput ? nameInput.value.trim() : '';

  if (!name) {
    if (nameInput) {
      nameInput.classList.add('shake');
      setTimeout(() => nameInput.classList.remove('shake'), 400);
    }
    return;
  }

  // Determine active type
  const activeTypeBtn = document.querySelector('.mcp-type-btn.active');
  const type = activeTypeBtn ? activeTypeBtn.dataset.type : 'stdio';

  let config;
  if (type === 'http') {
    const urlInput = $('#mcp-url');
    const url = urlInput ? urlInput.value.trim() : '';
    if (!url) {
      if (urlInput) {
        urlInput.classList.add('shake');
        setTimeout(() => urlInput.classList.remove('shake'), 400);
      }
      return;
    }
    config = { transport: 'http', url };
  } else {
    const cmdInput = $('#mcp-command');
    const argsInput = $('#mcp-args');
    const envInput = $('#mcp-env');
    const command = cmdInput ? cmdInput.value.trim() : '';
    if (!command) {
      if (cmdInput) {
        cmdInput.classList.add('shake');
        setTimeout(() => cmdInput.classList.remove('shake'), 400);
      }
      return;
    }

    config = { command };

    // Parse args
    const argsStr = argsInput ? argsInput.value.trim() : '';
    if (argsStr) {
      config.args = argsStr.split(',').map(a => a.trim()).filter(Boolean);
    }

    // Parse env
    const envStr = envInput ? envInput.value.trim() : '';
    if (envStr) {
      const env = {};
      for (const line of envStr.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          env[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
        }
      }
      if (Object.keys(env).length > 0) {
        config.env = env;
      }
    }
  }

  try {
    const res = await fetch('/api/mcp-servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config }),
    });
    if (!res.ok) throw new Error('Failed to add');
    const data = await res.json();
    renderMcpServers(data.servers);
    showToast(`Added "${name}"`, 'success');

    // Reset form
    resetMcpAddForm();
    $('#mcp-add-form').classList.add('hidden');
  } catch (err) {
    showToast('Failed to add server', 'info');
  }
}

function resetMcpAddForm() {
  const fields = ['#mcp-server-name', '#mcp-command', '#mcp-args', '#mcp-url'];
  for (const sel of fields) {
    const el = $(sel);
    if (el) el.value = '';
  }
  const envEl = $('#mcp-env');
  if (envEl) envEl.value = '';
  // Reset type toggle to stdio
  for (const btn of document.querySelectorAll('.mcp-type-btn')) {
    btn.classList.toggle('active', btn.dataset.type === 'stdio');
  }
  const stdioFields = $('#mcp-stdio-fields');
  const httpFields = $('#mcp-http-fields');
  if (stdioFields) stdioFields.classList.remove('hidden');
  if (httpFields) httpFields.classList.add('hidden');
}

function initMcpManager() {
  // Open button in titlebar
  const mcpBtn = $('#btn-mcp-manager');
  if (mcpBtn) mcpBtn.addEventListener('click', openMcpManager);

  // Close button
  const closeBtn = $('#btn-mcp-close');
  if (closeBtn) closeBtn.addEventListener('click', closeMcpManager);

  // Close on overlay click
  const overlay = $('#mcp-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeMcpManager();
    });
  }

  // Show add form toggle
  const showAddBtn = $('#btn-mcp-show-add');
  const addForm = $('#mcp-add-form');
  if (showAddBtn && addForm) {
    showAddBtn.addEventListener('click', () => {
      addForm.classList.toggle('hidden');
      if (!addForm.classList.contains('hidden')) {
        resetMcpAddForm();
        setTimeout(() => $('#mcp-server-name').focus(), 80);
      }
    });
  }

  // Cancel add
  const cancelBtn = $('#btn-mcp-cancel-add');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (addForm) addForm.classList.add('hidden');
    });
  }

  // Add server
  const addBtn = $('#btn-mcp-add');
  if (addBtn) addBtn.addEventListener('click', addMcpServer);

  // Type toggle
  for (const btn of document.querySelectorAll('.mcp-type-btn')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('.mcp-type-btn')) {
        b.classList.remove('active');
      }
      btn.classList.add('active');
      const stdioFields = $('#mcp-stdio-fields');
      const httpFields = $('#mcp-http-fields');
      if (btn.dataset.type === 'stdio') {
        if (stdioFields) stdioFields.classList.remove('hidden');
        if (httpFields) httpFields.classList.add('hidden');
      } else {
        if (stdioFields) stdioFields.classList.add('hidden');
        if (httpFields) httpFields.classList.remove('hidden');
      }
    });
  }

  // Enter key in add form fields submits
  for (const sel of ['#mcp-server-name', '#mcp-command', '#mcp-args', '#mcp-url']) {
    const el = $(sel);
    if (el) {
      el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); addMcpServer(); }
        if (e.key === 'Escape') { e.preventDefault(); closeMcpManager(); }
      });
    }
  }

  // Textarea keydown
  const envTextarea = $('#mcp-env');
  if (envTextarea) {
    envTextarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        addMcpServer();
      }
      if (e.key === 'Escape') { e.preventDefault(); closeMcpManager(); }
    });
  }
}

// ═══════════════════════════════════════════
// ITEM 1: File Split Resizer
// ═══════════════════════════════════════════

function initFileSplitResizer() {
  const resizer = $('#file-split-resizer');
  if (!resizer) return;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    fileSplitDragging = true;
    fileSplitDragStartY = e.clientY;
    fileSplitDragStartHeight = fileSplitHeight;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!fileSplitDragging) return;
    const delta = e.clientY - fileSplitDragStartY;
    const newHeight = Math.max(80, Math.min(fileSplitDragStartHeight + delta, window.innerHeight * 0.7));
    fileSplitHeight = newHeight;
    const split = $('#file-split');
    if (split) split.style.height = newHeight + 'px';
    refitActiveTerminal();
  });

  document.addEventListener('mouseup', () => {
    if (!fileSplitDragging) return;
    fileSplitDragging = false;
    const resizer = $('#file-split-resizer');
    if (resizer) resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    refitActiveTerminal();
  });
}

// ═══════════════════════════════════════════
// ITEM 2: Quick Action Buttons
// ═══════════════════════════════════════════

function initQuickActions() {
  const floatingInner = document.querySelector('.floating-input-inner');
  if (!floatingInner) return;

  const row = document.createElement('div');
  row.className = 'quick-actions';
  row.id = 'quick-actions-row';
  floatingInner.appendChild(row);

  renderQuickActions();
}

function renderQuickActions() {
  const row = $('#quick-actions-row');
  if (!row) return;

  const snippets = getSnippets();
  // Use saved snippets, or fall back to defaults
  const actions = snippets.length > 0 ? snippets : DEFAULT_SNIPPETS;

  row.innerHTML = '';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = 'quick-action-btn';
    btn.textContent = action.name;
    btn.title = action.text;
    btn.addEventListener('click', () => {
      if (!activeAgentId) return;
      send({ type: 'input', id: activeAgentId, data: action.text + '\r' });
      showToast(`Sent: ${action.text}`, 'info');
      // Refocus terminal
      const agent = agents.get(activeAgentId);
      if (agent) agent.terminal.focus();
    });
    row.appendChild(btn);
  }
}

// ═══════════════════════════════════════════
// ITEM 4: Session Timer & Heartbeat
// ═══════════════════════════════════════════

function initSessionTimer() {
  // Session timer updates every second
  if (sessionTimerInterval) { clearInterval(sessionTimerInterval); _intervals.delete(sessionTimerInterval); }
  sessionTimerInterval = setInterval(updateSessionTimer, 1000);
  _intervals.add(sessionTimerInterval);
}

function updateSessionTimer() {
  const timerEl = $('#session-timer');
  const heartbeatEl = $('#heartbeat');
  if (!timerEl || !heartbeatEl) return;

  // Find earliest startedAt across all agents
  let earliest = null;
  let hasActive = false;
  for (const agent of agents.values()) {
    if (agent.startedAt && (earliest === null || agent.startedAt < earliest)) {
      earliest = agent.startedAt;
    }
    if (agent.status === 'active') hasActive = true;
  }

  if (earliest === null || agents.size === 0) {
    timerEl.classList.add('hidden');
    heartbeatEl.classList.add('hidden');
    return;
  }

  // Show session timer
  timerEl.classList.remove('hidden');
  const diff = Math.floor((Date.now() - earliest) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) {
    timerEl.textContent = `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
  } else if (m > 0) {
    timerEl.textContent = `${m}m ${s.toString().padStart(2, '0')}s`;
  } else {
    timerEl.textContent = `${s}s`;
  }

  // Heartbeat: pulse when any agent has produced output in the last 3 seconds
  heartbeatEl.classList.remove('hidden');
  const recentOutput = (Date.now() - lastGlobalOutputTime) < 3000;
  if (hasActive && recentOutput) {
    heartbeatEl.classList.add('beating');
    heartbeatEl.classList.remove('idle');
  } else if (hasActive) {
    heartbeatEl.classList.remove('beating');
    heartbeatEl.classList.remove('idle');
  } else {
    heartbeatEl.classList.remove('beating');
    heartbeatEl.classList.add('idle');
  }
}

// ═══════════════════════════════════════════
// Remote Access (Cloudflare Tunnel)
// ═══════════════════════════════════════════

function initRemoteAccess() {
  const btn = $('#btn-remote-access');
  const overlay = $('#remote-overlay');
  const closeBtn = $('#btn-remote-close');
  const startBtn = $('#btn-tunnel-start');
  const stopBtn = $('#btn-tunnel-stop');

  if (!btn || !overlay) return;

  btn.addEventListener('click', () => {
    overlay.classList.remove('hidden');
    // Check current status
    fetch('/api/tunnel/status')
      .then(r => r.json())
      .then(data => {
        if (data.active && data.url) {
          showTunnelActive(data.url);
        } else {
          showTunnelInactive();
        }
      })
      .catch(() => showTunnelInactive());
  });

  closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));

  // PIN management
  const setPinBtn = $('#btn-set-pin');
  const clearPinBtn = $('#btn-clear-pin');
  const pinInput = $('#remote-pin-input');
  const pinStatus = $('#pin-status');

  function refreshPinStatus() {
    fetch('/api/auth/check').then(r => r.json()).then(data => {
      pinStatus.textContent = data.pinRequired ? 'PIN is set. Remote access requires authentication.' : 'No PIN set. Remote access is open to anyone with the URL.';
      pinStatus.style.color = data.pinRequired ? 'var(--color-success)' : 'var(--color-warning)';
    }).catch(() => {});
  }
  refreshPinStatus();

  if (setPinBtn) {
    setPinBtn.addEventListener('click', () => {
      const pin = pinInput.value.trim();
      if (pin.length < 4) { showToast('PIN must be at least 4 digits', 'error'); return; }
      fetch('/api/auth/set-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      }).then(r => r.json()).then(() => {
        showToast('PIN set. Remote access now requires authentication.', 'success');
        pinInput.value = '';
        refreshPinStatus();
      }).catch(err => showToast(err.message, 'error'));
    });
  }

  if (clearPinBtn) {
    clearPinBtn.addEventListener('click', () => {
      fetch('/api/auth/set-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: null }),
      }).then(r => r.json()).then(() => {
        showToast('PIN cleared. Remote access is now open.', 'info');
        pinInput.value = '';
        refreshPinStatus();
      }).catch(err => showToast(err.message, 'error'));
    });
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });

  startBtn.addEventListener('click', () => {
    $('#remote-status').style.display = 'none';
    $('#remote-loading').style.display = '';
    $('#remote-active').style.display = 'none';

    fetch('/api/tunnel/start', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          showToast(data.error, 'error');
          showTunnelInactive();
          return;
        }
        if (data.url) {
          showTunnelActive(data.url);
        } else {
          // URL pending, wait for WebSocket broadcast
          showToast('Tunnel starting, waiting for URL...', 'info');
        }
      })
      .catch(err => {
        showToast('Failed to start tunnel: ' + err.message, 'error');
        showTunnelInactive();
      });
  });

  stopBtn.addEventListener('click', () => {
    fetch('/api/tunnel/stop', { method: 'POST' }).catch(() => {});
    showTunnelInactive();
    showToast('Remote access disabled', 'info');
  });
}

function showTunnelInactive() {
  $('#remote-status').style.display = '';
  $('#remote-loading').style.display = 'none';
  $('#remote-active').style.display = 'none';
}

function showTunnelActive(url) {
  $('#remote-status').style.display = 'none';
  $('#remote-loading').style.display = 'none';
  $('#remote-active').style.display = '';

  const mobileUrl = url + '/mobile.html';
  const urlEl = $('#remote-url');
  urlEl.textContent = mobileUrl;
  urlEl.onclick = () => {
    navigator.clipboard.writeText(mobileUrl).then(() => showToast('URL copied', 'success'));
  };

  // Generate QR code as SVG
  const qrEl = $('#remote-qr');
  qrEl.innerHTML = '';
  generateQR(mobileUrl, qrEl);
}

// Minimal QR code generator (renders to canvas in a container)
function generateQR(text, container) {
  // Generate QR code using our own server endpoint (qrcode npm package)
  const img = document.createElement('img');
  img.style.width = '180px';
  img.style.height = '180px';
  img.style.borderRadius = '8px';
  img.src = '/api/qr?text=' + encodeURIComponent(text);
  img.alt = 'Scan to open Claude Nexus on your phone';
  img.onerror = () => {
    container.innerHTML = '<div style="padding:20px;font-size:11px;color:#333;word-break:break-all;">' + text + '</div>';
  };
  container.appendChild(img);
}

// Handle tunnel URL from WebSocket broadcast
function handleTunnelMessage(msg) {
  if (msg.url) {
    showTunnelActive(msg.url);
    showToast('Remote access enabled', 'success');
  } else {
    showTunnelInactive();
  }
}

document.addEventListener('DOMContentLoaded', init);
