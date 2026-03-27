const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Middleware ───
app.use(express.json());

// ─── Remote Access Authentication ───
// PIN-based auth for remote access. Local requests bypass auth.
// PIN is stored in ~/.claude-nexus/config.json
const crypto = require('crypto');
const NEXUS_CONFIG = path.join(os.homedir(), '.claude-nexus', 'config.json');
const authTokens = new Set(); // valid session tokens

function readNexusConfig() {
  try { return JSON.parse(fs.readFileSync(NEXUS_CONFIG, 'utf-8')); } catch { return {}; }
}

function writeNexusConfig(config) {
  const dir = path.join(os.homedir(), '.claude-nexus');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(NEXUS_CONFIG, JSON.stringify(config, null, 2), 'utf-8');
}

function isLocalRequest(req) {
  // If Cloudflare tunnel headers are present, the request is remote (even though
  // it arrives at localhost, the real client is elsewhere)
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return false;
  const ip = req.ip || req.connection.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

// Auth middleware: local requests pass through, remote requests need a valid token
app.use((req, res, next) => {
  // Always allow local requests (desktop app)
  if (isLocalRequest(req)) return next();

  // Allow the login page, auth endpoints, and PWA assets without a token
  if (req.path === '/login.html' || req.path.startsWith('/api/auth/') ||
      req.path === '/manifest.json' || req.path === '/icon.png' ||
      req.path === '/api/qr') return next();

  // Check for auth token in cookie or query param
  const config = readNexusConfig();
  if (!config.pin) return next(); // No PIN set, allow all

  const token = (req.cookies && req.cookies.nexus_token)
    || req.query.token
    || (req.headers.cookie && req.headers.cookie.match(/nexus_token=([^;]+)/)?.[1]);

  if (token && authTokens.has(token)) return next();

  // Redirect to login for HTML pages, 401 for API
  if (req.path.endsWith('.html') || req.path === '/') {
    return res.redirect('/login.html');
  }
  return res.status(401).json({ error: 'Authentication required' });
});

// Auth endpoints
app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  const config = readNexusConfig();
  if (!config.pin) {
    return res.json({ ok: true, message: 'No PIN set' });
  }
  if (pin === config.pin) {
    const token = crypto.randomBytes(32).toString('hex');
    authTokens.add(token);
    res.cookie('nexus_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 86400000 });
    return res.json({ ok: true, token });
  }
  return res.status(403).json({ error: 'Incorrect PIN' });
});

app.get('/api/auth/check', (req, res) => {
  const config = readNexusConfig();
  res.json({ pinRequired: !!config.pin });
});

app.post('/api/auth/set-pin', (req, res) => {
  // Only allow from local requests
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'Can only set PIN from desktop' });
  const { pin } = req.body;
  const config = readNexusConfig();
  config.pin = pin || null; // null to remove
  writeNexusConfig(config);
  if (pin) {
    authTokens.clear(); // Invalidate old sessions
  }
  res.json({ ok: true });
});

// ─── Static file serving ───
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/xterm-addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));

// ─── Session management ───
const sessions = new Map();
let sessionCounter = 0;

// ─── ANSI / control character stripping ───
// Claude Code uses a rich TUI with spinners, cursor movement, partial screen
// redraws, etc. We need very aggressive stripping to get clean text.
function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')              // CSI sequences
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')  // OSC sequences
    .replace(/\x1B\[\?[0-9;]*[hl]/g, '')                 // DEC private mode
    .replace(/\x1B[()][AB012]/g, '')                      // Character set
    .replace(/\x1B[78DEHM=><]/g, '')                      // Simple escapes
    .replace(/\x1B\[[\d;]*m/g, '')                        // SGR color
    .replace(/\x1B\[\d*[ABCDJKST]/g, '')                 // Cursor movement
    .replace(/\x1B\[\d*;\d*[Hf]/g, '')                   // Cursor position
    .replace(/\x1B\[\??\d+[hl]/g, '')                    // Mode set/reset
    .replace(/\x1B\[[\d;]*r/g, '')                       // Scroll region
    .replace(/\x1B[=>]/g, '')                            // Keypad modes
    .replace(/\x1B\[\d*X/g, '')                          // Erase chars
    .replace(/\x1B\[\d*G/g, '')                          // Cursor horizontal
    .replace(/\r\n?/g, '\n')                             // Normalize endings
    .replace(/\r/g, '')                                  // Stray carriage returns
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')  // Control chars
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●○◐◑◒◓⣾⣽⣻⢿⡿⣟⣯⣷]/g, '') // Spinner chars
    .replace(/[─│┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬]/g, '')    // Box drawing
    .replace(/\s{3,}/g, '  ')                            // Collapse whitespace
    .trim();
}

// ─── Question detection ───
//
// Dual-timer approach:
//   - FAST check (600ms silence): for high-confidence patterns (tool permissions,
//     yes/no prompts). These are almost never false positives.
//   - SLOW check (1.5s silence): for lower-confidence patterns (questions ending
//     with "?", selection menus). Needs more silence to avoid false triggers.

// HIGH confidence: almost certainly a prompt waiting for user input
const HIGH_CONFIDENCE_PATTERNS = [
  /Allow\s+\w+/i,
  /\(Y\)es/i,
  /\(y\/n\)/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\(yes\/no\)/i,
  /Yes\s*\/\s*No/i,
  /Are you sure/i,
  /Do you want to (proceed|continue)/i,
  /approve this/i,
  /❯\s+Yes/,
  /❯\s+No/,
];

// MEDIUM confidence: likely a question but could be prose
const MEDIUM_CONFIDENCE_PATTERNS = [
  /Do you want\b/i,
  /Would you like\b/i,
  /Should I\b/i,
  /Do you want me to\b/i,
  /What would you like/i,
  /How would you like/i,
  /Which\s+(one|option|approach)/i,
  /What should I\b/i,
  /Shall I\b/i,
  /proceed\?/i,
  /continue\?/i,
  /Can I\b.*\?/i,
  /\?\s*$/m,
  /❯\s+\w/m,
  /Press\s+(Enter|Return)/i,
];

// Lines to ignore when detecting questions (Claude Code UI chrome)
const IGNORE_LINE_PATTERNS = [
  /^[-=_~*]{3,}$/,            // Separator lines
  /^[❯►>]\s*$/,               // Bare prompt indicator
  /^\?\s+(for\s+)?shortc/i,   // "? for shortcuts" status bar
  /^esc\s+to/i,               // "esc to..." status bar
  /^costs?\s*:/i,             // Cost display
  /^model\s*:/i,              // Model display
  /^context/i,                // Context display
  /^[^a-zA-Z0-9]*$/,          // Lines with no alphanumeric chars
  /^compact\s*$/i,            // UI label
  /^auto-?accept/i,           // UI label
];

function isUiChrome(line) {
  const trimmed = line.trim();
  if (trimmed.length < 3) return true;
  for (const re of IGNORE_LINE_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

function detectQuestion(rawBuffer, isHighConfidenceCheck) {
  const clean = stripAnsi(rawBuffer);
  // Filter out Claude Code's UI chrome before analyzing
  const lines = clean.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 1 && !isUiChrome(l));
  if (lines.length === 0) return null;

  const tailLines = lines.slice(-20);
  const tail = tailLines.join('\n');

  // Choose which pattern set based on timer type
  const patterns = isHighConfidenceCheck ? HIGH_CONFIDENCE_PATTERNS : [
    ...HIGH_CONFIDENCE_PATTERNS,
    ...MEDIUM_CONFIDENCE_PATTERNS,
  ];

  let matched = false;
  for (const re of patterns) {
    if (re.test(tail)) { matched = true; break; }
  }

  if (!matched) return null;

  // Extract the question text: find the last "?" and walk back to sentence start
  const fullTail = tailLines.map(l => l.trim()).filter(Boolean).join(' ');
  const lastQ = fullTail.lastIndexOf('?');

  if (lastQ > 0) {
    let start = 0;
    for (let i = lastQ - 1; i >= 0; i--) {
      const c = fullTail[i];
      if (c === '.' || c === '!' || c === ':' || c === '\n') {
        start = i + 1;
        break;
      }
    }
    const extracted = fullTail.slice(start, lastQ + 1).trim();
    if (extracted.length > 5) return extracted;
  }

  // No "?" found: return the most relevant lines (likely a selection menu or prompt)
  const meaningful = tailLines
    .slice(-5)
    .map(l => l.trim())
    .filter(l => l.length > 2);
  return meaningful.join('\n') || tail.slice(-200);
}

// ─── Session creation ───
function createSession(name, cwd, command) {
  // Validate CWD
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      broadcast({ type: 'error', message: `Not a directory: ${cwd}` });
      return null;
    }
  } catch {
    broadcast({ type: 'error', message: `Directory not found: ${cwd}` });
    return null;
  }

  const id = `agent-${++sessionCounter}`;
  const isWin = process.platform === 'win32';
  const shell = isWin
    ? process.env.COMSPEC || 'cmd.exe'
    : process.env.SHELL || '/bin/zsh';
  const cmd = command || 'claude';

  let ptyProcess;
  try {
    const shellArgs = isWin ? ['/c', cmd] : ['-l', '-c', cmd];
    ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        HOME: os.homedir(),
      },
    });
  } catch (err) {
    broadcast({ type: 'error', message: `Failed to start agent: ${err.message}` });
    return null;
  }

  const session = {
    id,
    name,
    cwd,
    command: cmd,
    pty: ptyProcess,
    status: 'active',
    currentQuestion: null,
    startedAt: Date.now(),
    _buf: '',          // rolling output buffer for question detection
    _qTimerFast: null, // fast silence timer (600ms, high-confidence)
    _qTimerSlow: null, // slow silence timer (1.5s, all patterns)
    _lastOutput: Date.now(), // track last output time for idle detection
    _scrollback: [],   // saved output chunks for replay on reconnect
    _scrollbackSize: 0,
    // Preemptive UX: last line preview, smart notifications, idle tracking
    _lastLine: '',           // last meaningful line of output (ANSI-stripped)
    _smartStatus: 'active',  // 'active' | 'error' | 'complete' | 'idle'
    _idleTimer: null,        // fires after 3 min of silence
    _startupPrompt: null,    // optional initial prompt to send after startup
    _startupTimer: null,     // timer for delayed startup prompt
  };

  const MAX_SCROLLBACK = 200000; // ~200 KB of terminal output

  // Smart notification patterns
  const ERROR_PATTERNS = /\b(Error:|FAIL|panic:|Traceback|fatal:|ENOENT|Permission denied|ERR!|FATAL|SyntaxError|TypeError|ReferenceError|Cannot find)\b/i;
  const COMPLETION_PATTERNS = /\b(Done|Complete|Successfully|Finished|Build succeeded|All tests passed|passed)\b/i;
  const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

  ptyProcess.onData((data) => {
    session._lastOutput = Date.now();
    broadcast({ type: 'output', id, data });

    // Save for scrollback replay (new clients / page refresh)
    session._scrollback.push(data);
    session._scrollbackSize += data.length;
    while (session._scrollbackSize > MAX_SCROLLBACK && session._scrollback.length > 1) {
      session._scrollbackSize -= session._scrollback.shift().length;
    }

    // Append to rolling buffer (capped at 12 KB)
    session._buf += data;
    if (session._buf.length > 12000) {
      session._buf = session._buf.slice(-8000);
    }

    // Preemptive UX: Update last line preview (ANSI-stripped)
    // Filter out Claude Code's UI chrome: separator lines, prompt indicators,
    // status bar text, and other non-content lines.
    const cleanData = stripAnsi(data);
    const outputLines = cleanData.split('\n')
      .map(l => l.trim())
      .filter(l => {
        if (!l || l.length < 3) return false;
        // Skip separator lines (just dashes, equals, underscores)
        if (/^[-=_~*]{3,}$/.test(l)) return false;
        // Skip the prompt indicator line
        if (/^[❯►>]\s*$/.test(l)) return false;
        // Skip Claude Code status bar items
        if (/^\?\s+for\s+shortc/i.test(l)) return false;
        if (/^esc\s+to/i.test(l)) return false;
        if (/^costs?\s*:/i.test(l)) return false;
        if (/^model\s*:/i.test(l)) return false;
        if (/^context/i.test(l) && l.length < 30) return false;
        // Skip lines that are all special characters
        if (/^[^a-zA-Z0-9]*$/.test(l)) return false;
        return true;
      });
    if (outputLines.length > 0) {
      session._lastLine = outputLines[outputLines.length - 1].substring(0, 120);
      broadcast({ type: 'lastLine', id, line: session._lastLine });
    }

    // Preemptive UX: Smart notification detection
    const recentClean = stripAnsi(session._buf.slice(-2000));
    const recentLines = recentClean.split('\n').slice(-10).join('\n');

    if (ERROR_PATTERNS.test(recentLines)) {
      if (session._smartStatus !== 'error') {
        session._smartStatus = 'error';
        broadcast({ type: 'smartStatus', id, smartStatus: 'error', name: session.name });
      }
    } else if (COMPLETION_PATTERNS.test(recentLines)) {
      if (session._smartStatus !== 'complete') {
        session._smartStatus = 'complete';
        broadcast({ type: 'smartStatus', id, smartStatus: 'complete', name: session.name });
        // Auto-clear completion status after 8 seconds
        setTimeout(() => {
          if (session._smartStatus === 'complete') {
            session._smartStatus = 'active';
            broadcast({ type: 'smartStatus', id, smartStatus: 'active', name: session.name });
          }
        }, 8000);
      }
    } else if (session._smartStatus === 'error' || session._smartStatus === 'complete') {
      // New output that is neither error nor completion clears the status
      session._smartStatus = 'active';
      broadcast({ type: 'smartStatus', id, smartStatus: 'active', name: session.name });
    }

    // Preemptive UX: Reset idle timer on output
    if (session._idleTimer) clearTimeout(session._idleTimer);
    if (session._smartStatus === 'idle') {
      session._smartStatus = 'active';
      broadcast({ type: 'smartStatus', id, smartStatus: 'active', name: session.name });
    }
    session._idleTimer = setTimeout(() => {
      if (session.status === 'active' && !session.currentQuestion) {
        session._smartStatus = 'idle';
        broadcast({ type: 'smartStatus', id, smartStatus: 'idle', name: session.name });
      }
    }, IDLE_TIMEOUT_MS);

    // Reset both silence timers every time new output arrives
    if (session._qTimerFast) clearTimeout(session._qTimerFast);
    if (session._qTimerSlow) clearTimeout(session._qTimerSlow);

    const emitQuestion = (question) => {
      if (session.currentQuestion) return;
      session.status = 'waiting';
      session.currentQuestion = question;
      broadcast({
        type: 'question', id,
        name: session.name,
        text: question,
        timestamp: Date.now(),
      });
      broadcast({ type: 'status', id, status: 'waiting' });
    };

    // FAST check (600ms): high-confidence patterns only
    session._qTimerFast = setTimeout(() => {
      if (session.currentQuestion) return;
      const q = detectQuestion(session._buf, true);
      if (q) emitQuestion(q);
    }, 600);

    // SLOW check (1.5s): all patterns including "?" endings
    session._qTimerSlow = setTimeout(() => {
      if (session.currentQuestion) return;
      const q = detectQuestion(session._buf, false);
      if (q) emitQuestion(q);
    }, 1500);
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.status = 'exited';
    if (session._qTimerFast) clearTimeout(session._qTimerFast);
    if (session._qTimerSlow) clearTimeout(session._qTimerSlow);
    if (session._idleTimer) clearTimeout(session._idleTimer);
    if (session._startupTimer) clearTimeout(session._startupTimer);
    broadcast({ type: 'exited', id, code: exitCode });
    broadcast({ type: 'status', id, status: 'exited' });
  });

  sessions.set(id, session);
  return session;
}

// ─── WebSocket broadcasting ───
const clients = new Set();

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// ─── WebSocket handler ───
wss.on('connection', (ws) => {
  clients.add(ws);

  // Sync existing sessions to new client, including scrollback replay
  for (const session of sessions.values()) {
    ws.send(JSON.stringify({
      type: 'created',
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      command: session.command,
      status: session.status,
      question: session.currentQuestion,
      startedAt: session.startedAt,
      lastOutput: session._lastOutput,
      lastLine: session._lastLine || '',
      smartStatus: session._smartStatus || 'active',
    }));
    // Replay terminal output so the client sees the full conversation
    for (const chunk of session._scrollback) {
      ws.send(JSON.stringify({ type: 'output', id: session.id, data: chunk }));
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create': {
        const session = createSession(msg.name, msg.cwd, msg.command);
        if (session) {
          broadcast({
            type: 'created',
            id: session.id,
            name: session.name,
            cwd: session.cwd,
            command: session.command,
            status: session.status,
            startedAt: session.startedAt,
            lastOutput: session._lastOutput,
          });
          // Preemptive UX: Send startup prompt after 3-second delay
          if (msg.startupPrompt && msg.startupPrompt.trim()) {
            session._startupPrompt = msg.startupPrompt.trim();
            session._startupTimer = setTimeout(() => {
              if (session.pty && session.status !== 'exited') {
                session.pty.write(session._startupPrompt + '\r');
              }
            }, 3000);
          }
        }
        break;
      }

      // ── User input: the ONLY place where a pending question is cleared ──
      case 'input': {
        const session = sessions.get(msg.id);
        if (!session || !session.pty) break;

        session.pty.write(msg.data);

        if (session.currentQuestion) {
          session.currentQuestion = null;
          session.status = 'active';
          session._buf = '';           // flush buffer after user responds
          broadcast({ type: 'questionResolved', id: msg.id });
          broadcast({ type: 'status', id: msg.id, status: 'active' });
        }
        break;
      }

      case 'resize': {
        const session = sessions.get(msg.id);
        if (session && session.pty) {
          try { session.pty.resize(msg.cols, msg.rows); } catch {}
        }
        break;
      }

      case 'destroy': {
        const session = sessions.get(msg.id);
        if (session) {
          if (session._qTimerFast) clearTimeout(session._qTimerFast);
    if (session._qTimerSlow) clearTimeout(session._qTimerSlow);
          if (session._idleTimer) clearTimeout(session._idleTimer);
          if (session._startupTimer) clearTimeout(session._startupTimer);
          try { session.pty.kill(); } catch {}
          sessions.delete(msg.id);
          broadcast({ type: 'destroyed', id: msg.id });
        }
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
        break;
      }

      case 'browse': {
        try {
          const dirPath = msg.path || os.homedir();
          const showHidden = !!msg.showHidden;
          const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(e => showHidden || !e.name.startsWith('.'))
            .map(e => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
              path: path.join(dirPath, e.name),
            }))
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          ws.send(JSON.stringify({
            type: 'files', path: dirPath, entries,
            parent: path.dirname(dirPath),
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'readFile': {
        try {
          const stat = fs.statSync(msg.path);
          if (stat.size > 500000) {
            ws.send(JSON.stringify({ type: 'error', message: 'File too large to preview' }));
            break;
          }
          const content = fs.readFileSync(msg.path, 'utf-8');
          ws.send(JSON.stringify({
            type: 'fileContent',
            path: msg.path,
            name: path.basename(msg.path),
            content: content.slice(0, 100000),
            language: getLanguage(path.extname(msg.path).slice(1)),
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }
    }
  });

  ws.on('close', () => { clients.delete(ws); });
});

// ─── Language detection ───
function getLanguage(ext) {
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp', cs: 'csharp',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', mdx: 'markdown',
    sh: 'bash', zsh: 'bash', bash: 'bash', fish: 'bash',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    xml: 'xml', svg: 'xml', swift: 'swift', kt: 'kotlin',
    dart: 'dart', r: 'r', php: 'php', lua: 'lua',
  };
  return map[(ext || '').toLowerCase()] || 'plaintext';
}

// ─── Workspace presets REST API ───
const NEXUS_DIR = path.join(os.homedir(), '.claude-nexus');
const WORKSPACES_FILE = path.join(NEXUS_DIR, 'workspaces.json');

function ensureNexusDir() {
  try { fs.mkdirSync(NEXUS_DIR, { recursive: true }); } catch {}
}

function readWorkspaces() {
  try {
    return JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeWorkspaces(data) {
  ensureNexusDir();
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

app.get('/api/workspaces', (req, res) => {
  res.json(readWorkspaces());
});

app.post('/api/workspaces', (req, res) => {
  const { name, agents: agentList } = req.body;
  if (!name || !Array.isArray(agentList)) {
    return res.status(400).json({ error: 'name and agents[] required' });
  }
  const workspaces = readWorkspaces();
  // Upsert: replace if name exists
  const idx = workspaces.findIndex(w => w.name === name);
  const entry = { name, agents: agentList, savedAt: new Date().toISOString() };
  if (idx >= 0) {
    workspaces[idx] = entry;
  } else {
    workspaces.push(entry);
  }
  writeWorkspaces(workspaces);
  res.json({ ok: true, workspaces });
});

app.delete('/api/workspaces/:name', (req, res) => {
  const workspaces = readWorkspaces().filter(w => w.name !== req.params.name);
  writeWorkspaces(workspaces);
  res.json({ ok: true, workspaces });
});

// ─── File browser REST API (for modal folder picker) ───
app.get('/api/browse', (req, res) => {
  try {
    const dirPath = req.query.path || os.homedir();
    const showHidden = req.query.hidden === '1';
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => showHidden || !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        path: path.join(dirPath, e.name),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: dirPath, entries, parent: path.dirname(dirPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Directory validation API (for inline validation) ───
app.get('/api/validate-dir', (req, res) => {
  const dirPath = req.query.path;
  if (!dirPath) return res.json({ valid: false, error: 'No path provided' });
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return res.json({ valid: false, error: 'Not a directory' });
    }
    return res.json({ valid: true });
  } catch {
    return res.json({ valid: false, error: 'Directory not found' });
  }
});

// ─── MCP Server Manager REST API ───
const MCP_CONFIG_PATH = path.join(os.homedir(), '.mcp.json');

function readMcpConfig() {
  try {
    return JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8'));
  } catch {
    return { mcpServers: {} };
  }
}

function writeMcpConfig(config) {
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

app.get('/api/mcp-servers', (req, res) => {
  try {
    const config = readMcpConfig();
    res.json(config.mcpServers || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mcp-servers', (req, res) => {
  try {
    const { name, config: serverConfig } = req.body;
    if (!name || !serverConfig) {
      return res.status(400).json({ error: 'name and config are required' });
    }
    const fullConfig = readMcpConfig();
    if (!fullConfig.mcpServers) fullConfig.mcpServers = {};
    fullConfig.mcpServers[name] = serverConfig;
    writeMcpConfig(fullConfig);
    res.json({ ok: true, servers: fullConfig.mcpServers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/mcp-servers/:name', (req, res) => {
  try {
    const fullConfig = readMcpConfig();
    if (!fullConfig.mcpServers) fullConfig.mcpServers = {};
    delete fullConfig.mcpServers[req.params.name];
    writeMcpConfig(fullConfig);
    res.json({ ok: true, servers: fullConfig.mcpServers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cloudflare Tunnel for remote access ───
const { spawn: cpSpawn } = require('child_process');
let tunnelProcess = null;
let tunnelUrl = null;

app.post('/api/tunnel/start', (req, res) => {
  if (tunnelProcess) {
    return res.json({ ok: true, url: tunnelUrl, already: true });
  }

  // Find cloudflared binary
  const findCmd = process.platform === 'win32' ? 'where cloudflared 2>nul' : 'which cloudflared 2>/dev/null';
  let which = '';
  try { which = require('child_process').execSync(findCmd).toString().trim().split('\n')[0]; } catch {}
  if (!which) {
    return res.status(400).json({ error: 'cloudflared not installed. Run: brew install cloudflare/cloudflare/cloudflared' });
  }

  tunnelProcess = cpSpawn(which, ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let resolved = false;

  // cloudflared prints the URL to stderr
  tunnelProcess.stderr.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !resolved) {
      resolved = true;
      tunnelUrl = match[0];
      console.log(`  Tunnel:   \x1b[36m${tunnelUrl}\x1b[0m`);
      // Broadcast to all connected clients
      broadcast({ type: 'tunnel', url: tunnelUrl });
    }
  });

  tunnelProcess.on('exit', () => {
    tunnelProcess = null;
    tunnelUrl = null;
    broadcast({ type: 'tunnel', url: null });
  });

  // Wait up to 10s for the URL
  const check = setInterval(() => {
    if (resolved) {
      clearInterval(check);
      res.json({ ok: true, url: tunnelUrl });
    }
  }, 200);

  setTimeout(() => {
    if (!resolved) {
      clearInterval(check);
      resolved = true;
      res.json({ ok: true, url: null, pending: true });
    }
  }, 10000);
});

app.post('/api/tunnel/stop', (req, res) => {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
    tunnelUrl = null;
    broadcast({ type: 'tunnel', url: null });
  }
  res.json({ ok: true });
});

app.get('/api/tunnel/status', (req, res) => {
  res.json({ active: !!tunnelProcess, url: tunnelUrl });
});

// QR code generator endpoint
const QRCode = require('qrcode');
app.get('/api/qr', (req, res) => {
  const text = req.query.text;
  if (!text) return res.status(400).send('Missing text parameter');
  QRCode.toBuffer(text, {
    type: 'png',
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  }, (err, buffer) => {
    if (err) return res.status(500).send('QR generation failed');
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  });
});

// ─── Start server ───
const PORT = process.env.PORT || 3000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is in use. Try: PORT=3456 npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const interfaces = os.networkInterfaces();
  let networkUrl = '';
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        networkUrl = `http://${addr.address}:${PORT}`;
        break;
      }
    }
    if (networkUrl) break;
  }

  console.log('');
  console.log('  \x1b[38;5;99m\u25C6\x1b[0m \x1b[1mClaude Nexus\x1b[0m');
  console.log('');
  console.log(`  Local:    \x1b[36mhttp://localhost:${PORT}\x1b[0m`);
  if (networkUrl) {
    console.log(`  Network:  \x1b[36m${networkUrl}\x1b[0m`);
  }
  console.log('');
  console.log('  Press \x1b[1mCtrl+C\x1b[0m to stop');
  console.log('');
});

// ─── Cleanup ───
function cleanup() {
  for (const session of sessions.values()) {
    if (session._qTimerFast) clearTimeout(session._qTimerFast);
    if (session._qTimerSlow) clearTimeout(session._qTimerSlow);
    if (session._idleTimer) clearTimeout(session._idleTimer);
    if (session._startupTimer) clearTimeout(session._startupTimer);
    try { session.pty.kill(); } catch {}
  }
  process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
