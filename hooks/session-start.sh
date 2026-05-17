#!/bin/bash
# Train of Thought · SessionStart hook — fires when Claude Code starts a session.
# Reads JSON payload from stdin (Claude Code hook contract), forwards to daemon.
# Also auto-launches the Electron widget if it isn't already running.

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
CWD=$(echo "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -z "$CWD" ] && CWD="$PWD"
[ -z "$SESSION_ID" ] && SESSION_ID="local-$$"

# Fire-and-forget — if the Thought Tree v1 app isn't running, the event is just lost.
# Sir opens the app manually from Spotlight / Dock when he wants tracking.

PAYLOAD=$(printf '{"type":"session-start","session_id":"%s","cwd":"%s"}' "$SESSION_ID" "$CWD")
curl -s -m 1 -X POST http://127.0.0.1:3801/event \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null 2>&1 &
disown 2>/dev/null

exit 0
