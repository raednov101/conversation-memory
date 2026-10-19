---
name: settings
description: Show or change how often the conversation memory is summarized for this project (/conversation-memory:settings [every N | manual | auto]). Use only when the user runs this command.
---

The system has already applied the setting (or explained why it could not) before you read this. The `[conversation-memory]` note that came with this message gives the current setting and what summarizing has cost so far. Tell the user briefly, in their language:
- the current mode: automatic every N messages, or manual (only with /conversation-memory:save);
- the measured cost, said to be an estimate;
- how to change it: `/conversation-memory:settings every 10`, `manual`, or `auto`.

Messages are never lost in either mode: unsummarized messages are copied in full before the context is compacted and when the session ends. Do not edit any files yourself.
