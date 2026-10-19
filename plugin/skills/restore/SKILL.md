---
name: restore
description: List or restore earlier versions of the conversation memory (/conversation-memory:restore [number]). Use only when the user runs this command.
argument-hint: "[رقم النسخة]"
---

Without a number, the `[conversation-memory]` note lists the earlier versions, numbered, newest first. Show that list to the user as it is and tell them to run the command again with the number they want.

With a number, the system has already restored that version (or explained why it could not). Tell the user in one line what happened, from the note. The version that was current before is kept as a backup, so the restore can itself be undone. Do not edit the memory files yourself.
