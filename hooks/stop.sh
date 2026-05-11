#!/bin/bash
# Train of Thought · Stop hook — fires when Claude finishes responding.

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -z "$SESSION_ID" ] && SESSION_ID="local-$$"

PAYLOAD=$(printf '{"type":"stop","session_id":"%s"}' "$SESSION_ID")
curl -s -m 1 -X POST http://127.0.0.1:3801/event \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null 2>&1 &
disown 2>/dev/null

exit 0
