# Claude usage tracker extension

This extension is meant to help you gauge how much usage of claude you have left.

## Installation

### Chrome
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/knemcdpkggnbhpoaaagmjiigenifejfo.svg)](https://chrome.google.com/webstore/detail/claude-usage-tracker/knemcdpkggnbhpoaaagmjiigenifejfo)

### Firefox
[![Mozilla Add-on](https://img.shields.io/amo/v/claude-usage-tracker.svg)](https://addons.mozilla.org/firefox/addon/claude-usage-tracker)

### Features
The extension will correctly handle calculating token usage (via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer)) from:
- Files uploaded to the chat
- Project (knowledge files and instructions)
- Personal preferences
- Message history
- The system prompt of any enabled tools (analysis tool, artifacts) on a per-chat basis
- The AI's output (This is weighted as being 10x the usage of input tokens, a rough estimate)

### Limitations
- It cannot currently handle files from integrations (e.g., Google Drive)
- The GPT Tokenizer is a rough approximation

### Privacy
It will additionally fetch your organization ID on claude.ai to synchronize your usage amounts across devices via firebase.
Only the hashed value is stored, see the [privacy policy](PRIVACY.md) for more information.

### UI
![UI Screenshot](https://github.com/lugia19/Claude-Usage-Extension/blob/main/ui_screenshot.png?raw=true)
