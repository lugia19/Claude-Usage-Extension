# Claude usage tracker extension

This extension is meant to help you gauge how much usage of claude you have left.

The extension will correctly handle calculating token usage (via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer)) from:
- Files uploaded to the chat
- Project knowledge files (There is currently a bug on claude.ai's end that prevents this from working)
- Message history
- The AI's output (This is weighted as being 10x the usage of input tokens, a rough estimate)

It additionally will use a SHA-256 hash of your e-mail on claude.ai to synchronize your usage amounts across devices via firebase.

![usage_tracker_extension](https://github.com/user-attachments/assets/59949d8b-b759-4a92-8bd1-0a990f967dc7)
