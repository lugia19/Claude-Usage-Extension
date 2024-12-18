# Claude usage tracker extension

This extension is meant to help you gauge how much usage of claude you have left.

The extension will correctly handle calculating token usage (via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer)) from:
- Files uploaded to the chat
- Project (knowledge files and instructions)
- Personal preferences
- Message history
- The system prompt of any enabled tools (analysis tool, artifacts) on a per-chat basis
- The AI's output (This is weighted as being 10x the usage of input tokens, a rough estimate)

It cannot currently handle:
- Files from integrations (eg, google drive)

It will additionally fetch your organization ID on claude.ai to synchronize your usage amounts across devices via firebase.

![UI Screenshot](https://github.com/lugia19/Claude-Usage-Extension/blob/main/ui_screenshot.png?raw=true)
