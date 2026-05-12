// Train of Thought · claude.ai bridge
// Watches the chat DOM and fires hook-shaped events to the local daemon.

(function () {
  const DAEMON = 'http://127.0.0.1:3801';
  const POLL_MS = 600;             // how often we scan the DOM
  const STABILIZE_MS = 1200;        // assistant response is "done" if text hasn't changed for this long

  // ──────────────────────────────────────────────────────────────────────
  // Session bookkeeping
  // ──────────────────────────────────────────────────────────────────────
  let lastSessionId = null;
  let lastUserText = null;
  let lastAssistantId = null;
  let lastAssistantText = '';
  let lastAssistantChange = 0;
  let assistantStopFired = false;
  let started = new Set(); // session ids we've already announced

  function sessionId() {
    // /chat/<uuid>, /new, /project/<id>/chat/<uuid>, etc.
    const m = location.pathname.match(/\/chat\/([^/?#]+)/);
    if (m) return `claude-ai:${m[1]}`;
    const proj = location.pathname.match(/\/project\/([^/?#]+)/);
    if (proj) return `claude-ai:project-${proj[1]}`;
    return 'claude-ai:home';
  }

  function projectName() {
    // Best-effort: read the project / cowork title from the page header
    const titleEl = document.querySelector('[data-testid="chat-name"], header h1, [class*="project-name"]')
      || document.querySelector('header [class*="title"]');
    if (titleEl && titleEl.textContent) return titleEl.textContent.trim().slice(0, 60);
    return 'claude.ai';
  }

  function send(event) {
    try {
      fetch(`${DAEMON}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      }).catch(() => {});
    } catch {}
  }

  // ──────────────────────────────────────────────────────────────────────
  // DOM probes (claude.ai selectors — multiple fallbacks)
  // ──────────────────────────────────────────────────────────────────────
  function findMessages() {
    // Try several selector strategies — claude.ai's DOM changes occasionally
    const candidates = [
      '[data-message-author-role]',
      '[data-testid="message"]',
      '[class*="ConversationMessage"]',
      '[class*="message-content"]',
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) return Array.from(els);
    }
    return [];
  }

  function messageRole(el) {
    const r = el.getAttribute('data-message-author-role');
    if (r) return r.toLowerCase();
    // Heuristic: look for user/human indicators
    const cls = (el.className || '').toString().toLowerCase();
    if (cls.includes('user') || cls.includes('human')) return 'user';
    if (cls.includes('assistant') || cls.includes('claude')) return 'assistant';
    // Fallback: alternate by index (user, assistant, user, ...)
    return null;
  }

  function messageText(el) {
    return (el.innerText || el.textContent || '').trim();
  }

  // ──────────────────────────────────────────────────────────────────────
  // Main loop
  // ──────────────────────────────────────────────────────────────────────
  function tick() {
    const sid = sessionId();

    // New session detection
    if (sid !== lastSessionId) {
      lastSessionId = sid;
      lastUserText = null;
      lastAssistantId = null;
      lastAssistantText = '';
      assistantStopFired = false;
    }
    if (!started.has(sid)) {
      send({ type: 'session-start', session_id: sid, cwd: projectName() });
      started.add(sid);
    }

    const msgs = findMessages();
    if (msgs.length === 0) return;

    // Pair them as alternating user/assistant if role isn't on the element
    let users = [];
    let assistants = [];
    msgs.forEach((el, i) => {
      const r = messageRole(el);
      if (r === 'user') users.push(el);
      else if (r === 'assistant') assistants.push(el);
      else (i % 2 === 0 ? users : assistants).push(el);
    });

    // Detect a new user prompt
    const newestUser = users[users.length - 1];
    if (newestUser) {
      const text = messageText(newestUser);
      if (text && text !== lastUserText) {
        lastUserText = text;
        send({ type: 'user-prompt', session_id: sid, cwd: projectName(), prompt: text });
        assistantStopFired = false;
      }
    }

    // Detect assistant message completion (text stabilizes for STABILIZE_MS)
    const newestAssistant = assistants[assistants.length - 1];
    if (newestAssistant) {
      const id = newestAssistant.getAttribute('data-message-id')
        || newestAssistant.getAttribute('data-testid')
        || String(assistants.length);
      const text = messageText(newestAssistant);
      if (id !== lastAssistantId) {
        lastAssistantId = id;
        lastAssistantText = text;
        lastAssistantChange = Date.now();
        assistantStopFired = false;
      } else if (text !== lastAssistantText) {
        lastAssistantText = text;
        lastAssistantChange = Date.now();
      } else if (!assistantStopFired && Date.now() - lastAssistantChange > STABILIZE_MS && text.length > 5) {
        // Assistant response has finished — parse markers and forward
        assistantStopFired = true;
        parseAndSendMarkers(sid, text);
      }
    }
  }

  function parseAndSendMarkers(sid, text) {
    // Match the same convention the Stop hook uses: *label* (italic) and _summary_ (italic)
    // claude.ai may already render italics, so we look at innerText which preserves the asterisks/underscores
    const head = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0).slice(0, 6);
    let label = '';
    let summary = '';
    for (const line of head) {
      if (!label) {
        const m = line.match(/^\*([^*\n]{2,40})\*$/);
        if (m) { label = m[1].trim(); continue; }
      }
      if (!summary) {
        const m = line.match(/^_([^_\n]{2,100})_$/);
        if (m) { summary = m[1].trim(); continue; }
      }
      if (label && summary) break;
    }

    if (label) {
      send({ type: 'update-latest-label', session_id: sid, label });
    }
    if (summary) {
      send({ type: 'add-subthought', session_id: sid, text: summary });
    }
    send({ type: 'stop', session_id: sid });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Boot
  // ──────────────────────────────────────────────────────────────────────
  setInterval(tick, POLL_MS);

  // Re-scan on SPA route changes
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastSessionId = null;
      lastUserText = null;
      lastAssistantId = null;
    }
  }, 800);

  console.log('[toot] claude.ai bridge active');
})();
