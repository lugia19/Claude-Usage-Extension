# Claude usage counter
![usage_tracker_v2](https://github.com/user-attachments/assets/666beb20-b866-4e08-adeb-0aa47febb641)

Available on [Greasy Fork](https://greasyfork.org/en/scripts/515111-claude-usage-tracker)

This is basically a script meant to help you gauge how much usage of claude you have left.

It's still WIP, so the numbers for the caps of each model are mostly just guesses.
If you find that your experience doesn't match my guesses, let me know in the issues, and I'll update it!

The script will correctly handle calculating token usage from:
- Files uploaded to the chat
- Project knowledge files (So long as you let the page fully load, the project stuff can take an extra few seconds)
- Message history
- The AI's output (This is weighted as being 10x the usage of input tokens, based on the API pricing)

(And yes, this was mostly coded using Sonnet 3.5)

Now uses [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) to calculate token amounts.

# Claude temperature control - BROKEN!

Now broken. They setting the temperature.

Available on [Greasy Fork](https://greasyfork.org/en/scripts/515809-claude-temperature-control)

Lets you control the temperature (via a query parameter) on claude.ai

# Claude exporter

Available on [Greasy Fork](https://greasyfork.org/en/scripts/515448-claude-chat-exporter)

Does what it says. Exports the current chat to either jsonl or txt.
