# Claude Usage Tracker Extension

Track your Claude.ai token usage across conversations with this browser extension.

## Overview

This extension helps you monitor how much of your Claude usage quota remains. It calculates token consumption from various sources including uploaded files, project knowledge, chat history, and AI responses.

## Installation

### Chrome
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/knemcdpkggnbhpoaaagmjiigenifejfo.svg)](https://chrome.google.com/webstore/detail/claude-usage-tracker/knemcdpkggnbhpoaaagmjiigenifejfo)

### Firefox
[![Mozilla Add-on](https://img.shields.io/amo/v/claude-usage-tracker.svg)](https://addons.mozilla.org/firefox/addon/claude-usage-tracker)

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
