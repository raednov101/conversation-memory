---
name: history
description: Show the history of changes to the conversation memory — what changed, when, by what and why (/conversation-memory:history [all | decision id]). Use only when the user runs this command.
---

The system has already read the history before you read this. The `[conversation-memory]` note that came with this message lists the changes, newest first, each with its number (e12), time, what changed and what made the change (a summary of certain messages, the user's review, a correction, a restore, an undo).

Show the list to the user as it is, in their language, in a code block or a short list. Then tell them in one line that `/conversation-memory:undo e12` undoes that one change only, leaving the others as they are, and that it is refused if the same thing changed again later. Do not edit the memory files yourself.
