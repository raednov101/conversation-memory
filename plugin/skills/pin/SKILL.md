---
name: pin
description: Pin an approved text verbatim (/conversation-memory:pin [name]). Use only when the user runs this command.
argument-hint: "[اسم النص]"
---

The user wants a text from this conversation saved exactly as written. Follow the `[conversation-memory]` note that came with this message and the "تثبيت نص حرفياً" section of the conversation-memory skill:

1. Identify the text. If it is unclear which one is meant, ask the user; the request stays open for 3 messages.
2. Write the JSON file the note names, with the name and the exact first and last 20–80 characters of the text.
3. Don't quote the start and end in your reply. The system extracts the full text itself and confirms with 📌.
