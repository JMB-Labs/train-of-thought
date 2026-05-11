// Train of Thought daemon — receives Claude Code hook events, maintains the thought tree,
// broadcasts state to the Electron renderer via WebSocket.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = 3801;
const DATA_DIR = path.join(os.homedir(), '.train-of-thought');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// STATE
// ============================================================
let state = {
  nodes: [],
  edges: [],
  currentId: null,
  thinkingNodeId: null,  // node currently being worked on by Claude
  sessions: {}, // sessionId -> { rootId, lastNodeId, cwd }
};

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state = { ...state, ...raw };
    }
  } catch (e) { /* ignore */ }
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) { /* ignore */ }
}

load();

// ============================================================
// WEBSOCKET BROADCAST
// ============================================================
const clients = new Set();
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'state', state }));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleClientMessage(msg);
    } catch (e) { /* ignore */ }
  });
  ws.on('close', () => clients.delete(ws));
});

function broadcast() {
  const msg = JSON.stringify({ type: 'state', state });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function handleClientMessage(msg) {
  // Renderer can send commands: edit-node, delete-node, focus-node
  if (msg.type === 'focus-node') {
    state.currentId = msg.id;
    save();
    broadcast();
  } else if (msg.type === 'rename-node') {
    const node = state.nodes.find(n => n.id === msg.id);
    if (node) {
      node.label = msg.label;
      save();
      broadcast();
    }
  } else if (msg.type === 'delete-node') {
    deleteNode(msg.id);
    save();
    broadcast();
  } else if (msg.type === 'reset') {
    state = { nodes: [], edges: [], currentId: null, sessions: {} };
    save();
    broadcast();
  }
}

function deleteNode(id) {
  // Remove node and its descendants
  const toDelete = new Set([id]);
  let added = true;
  while (added) {
    added = false;
    for (const edge of state.edges) {
      if (toDelete.has(edge.from) && !toDelete.has(edge.to)) {
        toDelete.add(edge.to);
        added = true;
      }
    }
  }
  state.nodes = state.nodes.filter(n => !toDelete.has(n.id));
  state.edges = state.edges.filter(e => !toDelete.has(e.from) && !toDelete.has(e.to));
  // Update session pointers
  for (const sid of Object.keys(state.sessions)) {
    const s = state.sessions[sid];
    if (toDelete.has(s.lastNodeId)) s.lastNodeId = s.rootId;
    if (toDelete.has(s.rootId)) delete state.sessions[sid];
  }
  if (toDelete.has(state.currentId)) state.currentId = null;
}

// ============================================================
// HOOK EVENT HANDLING
// ============================================================
function summarize(text) {
  // MVP: take first 5 words, max 36 chars
  const words = (text || '').trim().split(/\s+/).slice(0, 5).join(' ');
  return words.length > 36 ? words.slice(0, 33) + '…' : words || '(empty prompt)';
}

function projectName(cwd) {
  if (!cwd) return 'session';
  return path.basename(cwd);
}

function ensureSession(sessionId, cwd) {
  if (state.sessions[sessionId]) return state.sessions[sessionId];
  const rootId = `s-${sessionId.slice(0, 8)}-${Date.now()}`;
  const now = new Date();
  const proj = projectName(cwd);
  state.nodes.push({
    id: rootId,
    label: `${proj} · ${now.toLocaleString('en-US', { month: 'short', day: 'numeric' })}`,
    kind: 'session',
    sessionId,
    cwd,
    timestamp: now.toISOString(),
  });
  state.sessions[sessionId] = { rootId, lastNodeId: rootId, cwd };
  return state.sessions[sessionId];
}

function handleEvent(event) {
  const sessionId = event.session_id || `unknown-${Date.now()}`;
  const cwd = event.cwd;

  if (event.type === 'session-start') {
    ensureSession(sessionId, cwd);
    state.currentId = state.sessions[sessionId].rootId;
  } else if (event.type === 'user-prompt') {
    const session = ensureSession(sessionId, cwd);
    const parentId = session.lastNodeId;
    const parentNode = state.nodes.find(n => n.id === parentId);
    const isSidetrack = parentNode && parentNode.cwd && cwd && parentNode.cwd !== cwd;
    const newId = `p-${Date.now()}`;
    state.nodes.push({
      id: newId,
      label: summarize(event.prompt),
      kind: isSidetrack ? 'sidetrack' : 'task',
      badge: isSidetrack ? 'sidetrack' : undefined,
      parentId,
      sessionId,
      cwd,
      timestamp: new Date().toISOString(),
    });
    state.edges.push({
      from: parentId,
      to: newId,
      sidetrack: isSidetrack,
    });
    session.lastNodeId = newId;
    state.currentId = newId;
    state.thinkingNodeId = newId;  // Claude is now working on this thought
  } else if (event.type === 'stop') {
    // Claude finished responding — clear thinking state
    state.thinkingNodeId = null;
  } else if (event.type === 'update-latest-label') {
    // Stop hook extracted a <train-of-thought> tag — refine the label
    const session = state.sessions[sessionId];
    if (session && event.label) {
      const node = state.nodes.find(n => n.id === session.lastNodeId);
      if (node) node.label = event.label.trim().slice(0, 40);
    }
    state.thinkingNodeId = null;
  }

  save();
  broadcast();
}

// ============================================================
// HTTP SERVER
// ============================================================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/event' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        handleEvent(event);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  res.writeHead(404);
  res.end();
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[toot] daemon listening on http://127.0.0.1:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { save(); server.close(); process.exit(0); });
process.on('SIGINT', () => { save(); server.close(); process.exit(0); });
