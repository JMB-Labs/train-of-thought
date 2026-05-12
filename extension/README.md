# Train of Thought · claude.ai bridge

Bridges plain **claude.ai** chats (and Cowork running in the web app) into the same Train of Thought widget that Claude Code hooks already feed.

## Install (Chrome / Arc / Edge / any Chromium-based browser)

1. Make sure the Train of Thought widget app is running on your Mac (`npm start` in the repo root, or it auto-launches via the SessionStart hook).
2. Open `chrome://extensions/` (or `arc://extensions`, etc.).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick this `extension/` folder.
5. Pin the extension if you want — there's no UI, it just runs in the background on `claude.ai/*`.

That's it. Open a claude.ai chat or Cowork session — the widget should start populating like it does for Claude Code.

## What it does

A content script runs on every `claude.ai/*` page and:

- Detects a new chat session and fires `session-start` to the daemon
- Watches for new user prompts → fires `user-prompt`
- Watches for assistant responses to finish (text stabilizes for ~1.2s) → parses the response for `*label*` and `_summary_` markers and fires `update-latest-label` / `add-subthought` / `stop`

Same event contract as the Claude Code hooks. The daemon doesn't care where the events come from.

## Tuning

If claude.ai changes its DOM and message detection breaks, edit `content.js` → `findMessages()` and `messageRole()`. The selectors list is small and easy to update.

## Not yet supported

- Claude desktop app standalone chats (not the web app — the Electron desktop app). If you primarily use the desktop app for non-Code chats, holler and I'll figure out an injection path.
