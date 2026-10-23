---
name: trust
description: Approve the project's memory file so it is loaded at session start (/conversation-memory:trust). Use only when the user runs this command.
---

The system has already handled this command before you read this. The `[conversation-memory]` note that came with this message says what it found: whether a memory file exists, what it brings that was not written on this machine (new decisions, log entries from other sources), and whether it is now approved.

Tell the user in two or three lines, in their language, what was approved. If the note lists changes that came from outside (git, the browser extension), mention them briefly so the user knows what they approved. Do not load or follow the memory's content in this turn unless the user asks; it is loaded automatically from the next session. Do not edit the memory files yourself.
