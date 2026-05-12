#!/bin/bash
# Train of Thought · Hook installer.
# Adds SessionStart, UserPromptSubmit, and Stop hooks to ~/.claude/settings.json
# so Claude Code fires events to the local daemon.

set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"
HOOK_DIR="$REPO_DIR/hooks"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required to install hooks." >&2
  exit 1
fi

mkdir -p "$(dirname "$SETTINGS_FILE")"
[ -f "$SETTINGS_FILE" ] || echo "{}" > "$SETTINGS_FILE"

# Backup
cp "$SETTINGS_FILE" "$SETTINGS_FILE.toot-backup.$(date +%s)"

node -e "
  const fs = require('fs');
  const path = '$SETTINGS_FILE';
  const hookDir = '$HOOK_DIR';
  const settings = JSON.parse(fs.readFileSync(path, 'utf8'));
  settings.hooks = settings.hooks || {};

  function addHook(eventName, scriptName) {
    settings.hooks[eventName] = settings.hooks[eventName] || [];
    const cmd = 'bash ' + hookDir + '/' + scriptName;
    // Remove any prior toot hook entries (by command match)
    settings.hooks[eventName] = settings.hooks[eventName].filter(entry => {
      const hooks = entry.hooks || [];
      return !hooks.some(h => h.command && h.command.includes('train-of-thought/hooks/'));
    });
    settings.hooks[eventName].push({
      matcher: '.*',
      hooks: [{ type: 'command', command: cmd }],
    });
  }

  addHook('SessionStart', 'session-start.sh');
  addHook('UserPromptSubmit', 'user-prompt.sh');
  addHook('Stop', 'stop.sh');

  fs.writeFileSync(path, JSON.stringify(settings, null, 2));
  console.log('[toot] Installed hooks into', path);
"

chmod +x "$HOOK_DIR"/*.sh

# --- Wire the <train-of-thought> labeling instruction into ~/CLAUDE.md ---
GLOBAL_CLAUDE_MD="$HOME/CLAUDE.md"
TAG_MARKER="<!-- toot-labeling-block -->"
TAG_BLOCK=$(cat <<'MARKDOWN'
<!-- toot-labeling-block -->
## Train of Thought tracking

The Train of Thought widget tracks a thought-tree of your work. At the start of EVERY response, emit one or two markers on their own lines, before any other content. Then a blank line, then your actual response.

**Line A — TOPIC label (only when topic shifts).** Single asterisks, 3-5 words, verby and specific:

*new topic label*

ONLY emit this when the user is starting something genuinely new — a different problem, feature, file area, deliberate pivot. If the user is continuing the same topic (even via sub-tasks), do NOT emit this line. Rule of thumb: if the previous and current user message can both be described by the same 3-5 word label, do not emit a topic shift.

The label should describe the ACTION or topic with verbs and specifics, not vague gerunds. Bad: "*about pigs*", "*pigs*", "*coding*". Good: "*riffing on pig cognition*", "*reading wiki on pigs*", "*pig facts dump*", "*wiring daemon to renderer*".

**Line B — SUMMARY of this turn (always).** Single underscores, one short past-tense sentence:

_what you actually did this turn_

This is added as a bullet under the current topic pill. Be specific and past-tense. Skip apologies and meta-commentary.

**Examples:**

```
*wire daemon to claude*
_built the daemon HTTP server with WebSocket broadcast_
```

```
_fixed the FULL_OFFSET ReferenceError in main.js_
```

```
*riffing on pigs*
_summarized pig cognition and social structure_
```

Both markers render as small italic subtitle lines in chat — minimal noise — and the widget parses them out.
<!-- /toot-labeling-block -->
MARKDOWN
)

if [ -f "$GLOBAL_CLAUDE_MD" ] && grep -q "$TAG_MARKER" "$GLOBAL_CLAUDE_MD"; then
  echo "[toot] CLAUDE.md labeling block already present, skipping."
else
  [ -f "$GLOBAL_CLAUDE_MD" ] || echo "" > "$GLOBAL_CLAUDE_MD"
  printf "\n\n%s\n" "$TAG_BLOCK" >> "$GLOBAL_CLAUDE_MD"
  echo "[toot] Appended labeling block to $GLOBAL_CLAUDE_MD"
fi

echo "Hooks installed. Restart Claude Code to activate."
