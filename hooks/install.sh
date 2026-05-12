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
## Train of Thought labeling

The Train of Thought widget is installed on this system. At the very start of EVERY response, on its own line BEFORE any other text, emit this HTML comment:

<!--toot:3-5 word label-->

The comment renders invisibly in chat but my widget parses it as the label for the current thought. Keep it short, verby, specific. Examples: "wire daemon to renderer", "fix POS UI bug", "rebuild auth flow", "riffing on pigs". Avoid cuteness — be clear.
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
