#!/bin/bash
# Train of Thought · SessionStart hook — fires when Claude Code starts a session.
# Reads JSON payload from stdin (Claude Code hook contract), forwards to daemon.
# Also auto-launches the Electron widget if it isn't already running.

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
CWD=$(echo "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -z "$CWD" ] && CWD="$PWD"
[ -z "$SESSION_ID" ] && SESSION_ID="local-$$"

# If the daemon isn't responding, the widget probably isn't running — launch it.
if ! curl -sS -m 1 http://127.0.0.1:3801/health >/dev/null 2>&1; then
  TOOT_DIR="$HOME/Projects/train-of-thought"
  if [ -d "$TOOT_DIR" ]; then
    (cd "$TOOT_DIR" && nohup npm start >/tmp/toot-launch.log 2>&1 &) >/dev/null 2>&1
    # Give the daemon a moment to come up before sending the event
    for i in 1 2 3 4 5 6 7 8 9 10; do
      curl -sS -m 1 http://127.0.0.1:3801/health >/dev/null 2>&1 && break
      sleep 0.3
    done
  fi
fi

PAYLOAD=$(printf '{"type":"session-start","session_id":"%s","cwd":"%s"}' "$SESSION_ID" "$CWD")
curl -s -m 1 -X POST http://127.0.0.1:3801/event \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null 2>&1 &
disown 2>/dev/null

exit 0
