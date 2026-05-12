#!/bin/bash
# Train of Thought · Stop hook
# Reads Claude's response transcript, extracts <train-of-thought>...</train-of-thought> tag,
# and refines the latest node's label.

INPUT=$(cat)

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

# Parse the input JSON to get session_id and transcript_path
PARSED=$(echo "$INPUT" | node -e '
  let buf = "";
  process.stdin.on("data", c => buf += c);
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(buf);
      process.stdout.write(JSON.stringify({
        session_id: j.session_id || "",
        transcript_path: j.transcript_path || "",
      }));
    } catch (e) {
      process.stdout.write("{}");
    }
  });
')

SESSION_ID=$(echo "$PARSED" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{process.stdout.write(JSON.parse(b).session_id||"")}catch(e){}})')
TRANSCRIPT_PATH=$(echo "$PARSED" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{process.stdout.write(JSON.parse(b).transcript_path||"")}catch(e){}})')

[ -z "$SESSION_ID" ] && SESSION_ID="local-$$"

# Extract the most recent assistant message text and look for a <train-of-thought> tag
LABEL=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  # Extract label and/or summary from the most recent assistant message
  PARSED=$(node -e '
    (function() {
      const fs = require("fs");
      const path = process.argv[1];
      try {
        const lines = fs.readFileSync(path, "utf8").trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          let j;
          try { j = JSON.parse(lines[i]); } catch (e) { continue; }
          if (j.type !== "assistant" && j.role !== "assistant" && j.message?.role !== "assistant") continue;
          let text = "";
          const content = j.message?.content || j.content || "";
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === "text" && part.text) text += part.text + "\n";
            }
          }
          if (!text.trim()) continue;
          // Parse the first few non-empty lines for *label* and _summary_
          const head = text.split("\n").map(l => l.trim()).filter(l => l.length > 0).slice(0, 6);
          let label = "";
          let summary = "";
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
          // Legacy formats also accepted for label
          if (!label) {
            let m = text.match(/<!--\s*toot:\s*([^\n>]+?)\s*-->/i)
                 || text.match(/<train-of-thought>([\s\S]*?)<\/train-of-thought>/i);
            if (m) label = m[1].trim();
          }
          process.stdout.write(JSON.stringify({ label, summary }));
          return;
        }
        process.stdout.write("{}");
      } catch (e) { process.stdout.write("{}"); }
    })();
  ' "$TRANSCRIPT_PATH")

  LABEL=$(echo "$PARSED" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{const j=JSON.parse(b);process.stdout.write(j.label||"")}catch(e){}})')
  SUMMARY=$(echo "$PARSED" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{const j=JSON.parse(b);process.stdout.write(j.summary||"")}catch(e){}})')
fi

# Send Stop event first (clears thinking state)
STOP_PAYLOAD=$(printf '{"type":"stop","session_id":"%s"}' "$SESSION_ID")
curl -s -m 1 -X POST http://127.0.0.1:3801/event \
  -H "Content-Type: application/json" -d "$STOP_PAYLOAD" >/dev/null 2>&1 &
disown 2>/dev/null

# Send the label first (may create a branch on topic shift)
if [ -n "$LABEL" ]; then
  PAYLOAD=$(node -e '
    process.stdout.write(JSON.stringify({
      type: "update-latest-label",
      session_id: process.argv[1],
      label: process.argv[2],
    }));
  ' "$SESSION_ID" "$LABEL")
  curl -s -m 1 -X POST http://127.0.0.1:3801/event \
    -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null 2>&1
fi

# Then add the per-turn summary as a sub-thought of the current pill
if [ -n "$SUMMARY" ]; then
  PAYLOAD=$(node -e '
    process.stdout.write(JSON.stringify({
      type: "add-subthought",
      session_id: process.argv[1],
      text: process.argv[2],
    }));
  ' "$SESSION_ID" "$SUMMARY")
  curl -s -m 1 -X POST http://127.0.0.1:3801/event \
    -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null 2>&1 &
  disown 2>/dev/null
fi

exit 0
