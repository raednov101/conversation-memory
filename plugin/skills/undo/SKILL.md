---
name: undo
description: Undo the last change to the conversation memory, or one change from its history (/conversation-memory:undo [e12]). Use only when the user runs this command.
---

The system has already acted before you read this. The `[conversation-memory]` note that came with this message says what happened. Tell the user in one line, in their language:
- with a change number (`/conversation-memory:undo e12`): which change was undone, that the other changes stayed as they were, and that the undo itself is in `/conversation-memory:history` and can be undone too — or why it was refused (usually: the same thing changed again later, so that later change must be undone first);
- without a number: which version of the memory was restored (its date), and that running the command again brings back what was undone; or why nothing changed.

Do not edit the memory files yourself.
