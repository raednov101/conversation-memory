---
name: fix
description: Correct the conversation memory (/conversation-memory:fix [what to correct]). Use only when the user runs this command.
argument-hint: "[ما الذي يُصحَّح]"
---

The user wants to correct something in the saved memory: a decision's wording, a suggestion they now approve, a decision to cancel or delete, a constraint, the current summary, or a log entry that is wrong.

1. Follow the `[conversation-memory]` note that came with this message. Read `CONVERSATION_MEMORY.json` to find the exact ids (decisions `d1`…, and each log entry's `id`).
2. If it is unclear what should change, ask the user first. The request stays open for 3 messages.
3. Write only the correction into the JSON file the note names, in the format the note shows. Never edit the memory files themselves.
4. Tell the user in one line what will change. The system applies it after your reply, keeps a backup, and confirms with ✏️. `/conversation-memory:undo` reverts it.
