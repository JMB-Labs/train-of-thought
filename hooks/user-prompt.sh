#!/bin/bash
# Train of Thought · UserPromptSubmit hook — fires when the user submits a prompt.
# Forwards prompt + session info to the daemon.

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
CWD=$(echo "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -z "$CWD" ] && CWD="$PWD"
[ -z "$SESSION_ID" ] && SESSION_ID="local-$$"

# Extract the prompt text. Use node for robust JSON parsing if available.
if command -v node >/dev/null 2>&1; then
  PROMPT=$(echo "$INPUT" | node -e '
    let buf = "";
    process.stdin.on("data", c => buf += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(buf);
        process.stdout.write(j.prompt || j.user_prompt || j.message || "");
      } catch (e) {}
    });
  ')
else
  PROMPT=$(echo "$INPUT" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi

# JSON-encode the prompt
if command -v node >/dev/null 2>&1; then
  PAYLOAD=$(node -e "
    const p = process.argv[1];
    const s = process.argv[2];
    const c = process.argv[3];
    process.stdout.write(JSON.stringify({
      type: 'user-prompt',
      session_id: s,
      cwd: c,
      prompt: p,
    }));
  " "$PROMPT" "$SESSION_ID" "$CWD")
else
  # crude fallback — works for prompts without quotes/newlines
  PAYLOAD=$(printf '{"type":"user-prompt","session_id":"%s","cwd":"%s","prompt":"%s"}' "$SESSION_ID" "$CWD" "$PROMPT")
fi

curl -s -m 1 -X POST http://127.0.0.1:3801/event \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null 2>&1 &
disown 2>/dev/null

exit 0
