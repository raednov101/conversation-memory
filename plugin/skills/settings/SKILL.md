---
name: settings
description: Show or change when the conversation memory is summarized for this project, and its language (/conversation-memory:settings [session | every N | manual | auto | lang ar | lang en | lang auto]). Use only when the user runs this command.
---

The system has already applied the setting (or explained why it could not) before you read this. The `[conversation-memory]` note that came with this message gives the current setting and what summarizing has cost so far. Tell the user briefly, in their language:
- the current mode: at the session's edges (the default: before the context is compacted and at exit, with no cost while working), automatic every N messages, or manual (only with /conversation-memory:save);
- the measured cost, said to be an estimate;
- the language of the plugin's messages and of a new memory: automatic (the language the user writes in) unless set;
- how to change them: `/conversation-memory:settings session`, `every 10`, `manual`, or `lang ar` / `lang en` / `lang auto`.

Messages are never lost in any mode: unsummarized messages are copied in full before the context is compacted and when the session ends. Do not edit any files yourself.
