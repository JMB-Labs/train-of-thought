# Train of Thought

A live thought-tree companion for [Claude Code](https://claude.com/claude-code). Always-on-top floating widget that shows what you're working on right now and how it branches.

![Train of Thought](docs/hero.png)

## What it does

Every time you start a Claude Code session or send a prompt, a hook fires an event to a local daemon. The daemon builds a tree of your "thoughts" — sessions, tasks, sidetracks — and pushes live updates to the Electron app.

- **Minimized:** a 240×80 pill in the top-right corner showing what you're currently working on.
- **Maximized:** a 800×560 canvas showing the whole tree, with each pill labeled by its parent context.
- **Sidetracks:** when you switch projects (`cwd` changes), the new task is automatically rendered as a dashed-line branch with a `SIDETRACK` badge.

## How it works

```
┌─────────────────┐     hook event       ┌──────────────┐     WebSocket      ┌────────────────┐
│   Claude Code   │ ───────────────────► │    Daemon    │ ─────────────────► │  Electron App  │
│  (your session) │  via shell scripts   │ (Node, 3801) │  state broadcasts  │  (the widget)  │
└─────────────────┘                      └──────┬───────┘                    └────────────────┘
                                                │
                                                ▼
                                         ~/.train-of-thought/state.json
                                         (persisted tree, survives restarts)
```

Three pieces:

1. **Hooks** (`hooks/*.sh`) — fired by Claude Code on `SessionStart`, `UserPromptSubmit`, and `Stop`. They `POST` JSON to the daemon.
2. **Daemon** (`daemon.js`) — local Node server on `127.0.0.1:3801`. Receives events, maintains the thought tree in memory, persists to disk, broadcasts state to WebSocket clients.
3. **Electron app** (`main.js` + `renderer/`) — frameless transparent always-on-top window. Connects to the daemon, computes a top-down tree layout for whatever the daemon sends, and renders.

## Install

```bash
git clone https://github.com/JMB-Labs/train-of-thought.git
cd train-of-thought
npm install

# Wire the hooks into Claude Code's settings.json
bash hooks/install.sh

# Run
npm start
```

Restart Claude Code after running `install.sh` so it picks up the new hooks.

## Architecture notes

- **Frame is transparent**, the pill carries its own bg. macOS-native floating-widget aesthetic.
- **All animations are 350ms**, synced between window resize (custom `setBounds` tween in `main.js`) and CSS transitions. Click-to-focus uses a slower 1.05s camera pan.
- **Auto-layout**: the daemon doesn't send pixel positions — the renderer computes a top-down tree layout each time it receives state. Add a node and the whole tree re-arranges.
- **Sidetrack detection**: if a new prompt has a different `cwd` than its parent, it's flagged as a sidetrack and renders with a dashed-line branch.
- **Magic write**: when a brand-new node arrives, its label fades in character-by-character (a 0.95s blur-clear effect per char with 50ms stagger). Switching views or clicking existing pills doesn't re-trigger it.
- **Dark mode** follows Claude.ai's chat-area bg (`#1F1E1D`). Text is a soft luminous blue (`#A0BEDF`) — supposed to feel like a thought floating in space.

## Controls

| Key / action | Effect |
|---|---|
| Click pill | Expand the widget to the full tree |
| Click any pill in tree | Focus on it (camera pans, daemon updates current) |
| `T` | Toggle focused view ↔ full tree |
| `B` | Spawn a demo sidetrack from the current pill |
| `D` | Toggle dark / light theme |
| `Esc` | Minimize back to pill |

## Roadmap

- [ ] Right-click context menu (rename, delete, jump to parent)
- [ ] Per-project filter — show only tree branches for current `cwd`
- [ ] Haiku-summarized labels (replace word-trim with real semantic 3-5 word labels)
- [ ] Windows port (Sir has a Mac mini today, will eventually port like JARVIS)
- [ ] Cloud sync — see your trees from any machine

## Built by

[Jian Miguel Bautista](https://github.com/jmbonnevie) (Sir), as part of the [AIBOS](https://aibos.ai) project.

## License

MIT
