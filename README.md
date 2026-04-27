# Claude Usage Tracker Extension

Track your Claude.ai token usage across conversations with this browser extension.

Also check out my other extension, [[Claude QoL](https://github.com/lugia19/Claude-QoL)] (includes summarizing, TTS, STT and way more).

## Overview

This extension helps you monitor how much of your Claude usage quota remains. It calculates token consumption from various sources including uploaded files, project knowledge, chat history, and AI responses.

## Run locally

There is no separate dev server—the extension only runs inside the browser on **https://claude.ai/**.

### Prerequisites

- **Node.js** (for the dataclass build script).
- **Chromium** (Chrome, Edge, Brave, etc.) or **Firefox**.
- **Vendored `lib/`** files referenced by the manifest: `lib/browser-polyfill.min.js`, `lib/o200k_base.js` (tokenizer). If your clone is missing `lib/`, restore it from the full upstream repo or an official release zip.
- **Icons** `icon128.png` and `icon512.png` in the project root (required by the manifest). This repo’s `.gitignore` may exclude `*.png`; copy icons from a release build or generate matching assets if needed.

### 1. Generate the content-script dataclasses

`content-components/ui_dataclasses.js` is produced from `shared/dataclasses.js` and may be gitignored. Run after clone or whenever you change `shared/dataclasses.js`:

```bash
node scripts/build-dataclasses.js
```

### 2. Chrome / Chromium (unpacked)

The browser expects a file named `manifest.json` in the folder you load. This repo keeps per-target manifests; for Chrome, copy the Chrome manifest:

```bash
cp manifest_chrome.json manifest.json
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and choose this project directory.

Reload the extension after code changes. Use **https://claude.ai/** while logged in to see injected UI.

### 3. Firefox (temporary load)

Open **about:debugging** → **This Firefox** → **Load Temporary Add-on…** and select **`manifest_firefox.json`** (Firefox uses a `background.scripts` entry instead of Chrome’s service worker field).

Note: `manifest.json` is gitignored so local copies do not get committed.

### Debugging

- Toolbar popup → **Debug Logs** opens `debug.html`.
- Chrome: extension icon context menu → **Open Debug Page** (same debug page).

## Tech stack

| Area | Details |
|------|---------|
| Platform | **Manifest V3** (Chrome); Firefox MV3 with `background.scripts` |
| Language | **JavaScript** (ES modules in the service worker / background) |
| APIs | `storage`, `alarms`, **`webRequest`**, `tabs`, `contextMenus`, `notifications` |
| Libraries | [webextension-polyfill](https://github.com/mozilla/webextension-polyfill), [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (`o200k_base` bundle) |
| Hosts | `claude.ai`, GitHub (raw), `api.anthropic.com` (optional token counting with your key) |
| Build | Plain Node script for dataclasses; optional **`web-ext`** for packaged zips (see `build.bat`) |

## Build release packages (optional)

On Windows, `build.bat` runs `scripts/build-dataclasses.js`, copies each of `manifest_chrome.json`, `manifest_firefox.json`, and `manifest_electron.json` to `manifest.json` in turn, and invokes **`web-ext build`**. Install `web-ext` globally or via a local `package.json` (this repo gitignores `package.json`; add your own tooling if needed).

On macOS/Linux, mirror the same steps: generate dataclasses, copy the target manifest to `manifest.json`, then run `web-ext build` with your desired output filename.

## Repository layout

| Path | Role |
|------|------|
| `background.js` | Service worker entry; wires listeners and webRequest |
| `bg-components/` | Background helpers (API, tokens, utils, Electron compat) |
| `content-components/` | Scripts injected on `claude.ai` (usage UI, notifications, etc.) |
| `shared/dataclasses.js` | Shared types; compiled to `content-components/ui_dataclasses.js` for content scripts |
| `injections/` | Injected scripts exposed via `web_accessible_resources` |
| `manifest_*.json` | Chrome, Firefox, and Electron manifest variants |

## Installation (end users)

### Chrome
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/knemcdpkggnbhpoaaagmjiigenifejfo.svg)](https://chrome.google.com/webstore/detail/claude-usage-tracker/knemcdpkggnbhpoaaagmjiigenifejfo)

### Firefox
[![Mozilla Add-on](https://img.shields.io/amo/v/claude-usage-tracker.svg)](https://addons.mozilla.org/firefox/addon/claude-usage-tracker)

### Desktop Client

[MacOS/Windows installer](https://github.com/lugia19/Claude-WebExtension-Launcher/releases/latest)

## Features

The extension tracks token usage from:

- **Files** - Documents uploaded to chats or synced via Google Drive, Github, etc
- **Projects** - Knowledge files and custom instructions
- **Personal preferences** - Your configured settings
- **Message history** - Full conversation context
- **System prompts** - Enabled tools (analysis, artifacts) on a per-chat basis
- **MOST MCPs/Integrations** - There are some limitations in cases where a "Knowledge" object is returned that I can't access, such as with web search

Limitations:

- **Web search results** - The full results are not exposed in the conversation history, so I can't track them properly
- **Research** - Most of it happens on the backend, so I can't track it

Token calculation is handled either through Anthropic's API (if you provide your key) or via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer).

## Privacy

The extension fetches your organization ID from claude.ai to synchronize usage data across devices using Firebase. For full details, see the [privacy policy](PRIVACY.md).

## UI

Most elements in the chat UI (Namely the length, cost, estimate, caching status) have a tooltip explaining them further.

![Claude Usage Tracker UI](https://github.com/lugia19/Claude-Usage-Extension/blob/main/ui_screenshot.png?raw=true)
