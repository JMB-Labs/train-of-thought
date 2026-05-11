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

echo "Hooks installed. Restart Claude Code to activate."
