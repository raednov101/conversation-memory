---
name: share
description: Hand chosen parts of the memory to another conversation, after a preview (/conversation-memory:share [items]). Use only when the user runs this command.
argument-hint: "[summary d1 L2 pin:اسم …]"
---

Without items, the `[conversation-memory]` note lists what can be shared (the summary, constraints, decisions, pinned texts, log entries). Show the list as it is and explain that the user runs the command again with the items they choose, for example `/conversation-memory:share summary d1 L2`.

With items, the system has prepared the text and saved it to a file. Show the preview from the note exactly as it is, then tell the user how to use it in the other conversation, as the note says. Do not add anything to the shared text.
