# The conversation memory format — `conversation-memory/1`

> مواصفة صيغة ملف الذاكرة لمن يريد قراءته أو الكتابة فيه من أداة أخرى. الملف ملكك، وهذه الصفحة تشرح كل ما فيه.

This page is for anyone who wants to read or write the memory from another tool: a script, an editor plugin, another
assistant. The memory is plain files in your project; nothing here needs this product to be installed.

The machine-readable schema is [`schema/conversation-memory-1.schema.json`](schema/conversation-memory-1.schema.json)
(JSON Schema 2020-12). `tests/format.test.js` checks it against everything the real writers produce.

## Files

| Path (in the project folder) | What it is | Who writes it |
|---|---|---|
| `CONVERSATION_MEMORY.json` | **The source of truth.** UTF-8 JSON, at most 4 MB. | The writers only |
| `CONVERSATION_MEMORY.md` | A readable view generated from the JSON, in the memory's language. Edits to it are kept aside, never lost (see *Hand edits*). | Generated |
| `CONVERSATION_PINS/<name>/vN.md` | Approved texts kept verbatim, one file per version. | The writers, on request |
| `.conversation-memory/` | Working data, git-ignored (it writes its own `.gitignore`). | The writers |
| `.conversation-memory/backups/*.json` | Up to 20 earlier versions of the JSON. Named `YYYYMMDD-HHMMSS-mmm[-xxxx].json` in UTC. | The writers |
| `.conversation-memory/archive/*.json` | Old log entries moved out to keep the file small. | The writers |
| `.conversation-memory/write.lock` | The shared write lock (see *Writing safely*). | The writers |
| `.conversation-memory/project-id` | 16 hex characters identifying the project folder. | The writers |
| `.conversation-memory/inbox/` | Drafts written by Claude in Claude Code; untrusted until validated. | Claude (plugin only) |

## The document

```json
{
  "format": "conversation-memory/1",
  "title": "Coffee shop identity",
  "lang": "en",
  "updated": "2026-10-26 10:05",
  "summary": { "goal": "…", "status": "…", "next": ["…"], "open": ["…"] },
  "decisions": [
    { "id": "d1", "text": "Dark blue is the brand colour", "source": "user", "date": "2026-10-26 10:00",
      "status": "active", "revokedOn": "", "replaces": "", "quote": "let's go with dark blue", "unverified": false, "msg": 4 }
  ],
  "constraints": ["Budget 40,000"],
  "pending": { "constraints": { "add": [], "remove": [] } },
  "pins": [{ "name": "welcome", "version": 2, "path": "CONVERSATION_PINS/welcome/v2.md", "sha": "…64 hex…", "date": "…" }],
  "log": [
    { "id": "<batch id>", "platform": "chatgpt", "chat": "Brand chat", "range": "1–5", "date": "…",
      "raised": ["…"], "decided": ["…"], "changed": ["…"] }
  ],
  "imported": null,
  "mdHash": "…",
  "archived": 0
}
```

### Top level

| Field | Meaning |
|---|---|
| `format` | `conversation-memory/<n>`. Writers of this version write `1`. |
| `title` | The project's name (≤ 200 characters). |
| `lang` | `ar` or `en`: the language of the Markdown view. A file without it is from before 2.0 and is Arabic. It stays the same whoever writes next. |
| `updated` | Local time of the last change, `YYYY-MM-DD HH:MM`. |
| `summary` | The whole project now: `goal`, `status`, `next` steps, `open` questions. Rewritten by each summary. |
| `decisions` | What was decided, each with its evidence. Never deleted: a cancelled decision is `revoked`. |
| `constraints` | Standing rules (unique strings). |
| `pending.constraints` | Constraint additions and removals the model suggested without the user's words, waiting for the user. |
| `pins` | The index of pinned texts. |
| `log` | One entry per summary, oldest first. The newest 2000 stay; older ones move to the archive. |
| `imported` | `{date, text}`: a `CONVERSATION_MEMORY.md` from before the JSON existed, kept as it was; otherwise `null`. |
| `mdHash` | Fingerprint of the Markdown view generated with this version. |
| `archived` | How many log entries were moved to the archive so far. |
| `history` | Every change, oldest first (see *History*). The newest 400 stay. |

### Decisions

| Field | Meaning |
|---|---|
| `id` | `d` + number, unique, never reused. |
| `text` | The decision, with the meaning the user gave it. |
| `source` | `user` — the user decided it; `assistant-approved` — the model suggested it and the user agreed; `assistant` — the model's suggestion, not approved. |
| `quote` | The user's own words it rests on, verbatim (≤ 300 characters). |
| `msg` | The number of the user message it was decided in, when known. |
| `status`, `revokedOn` | `active` or `revoked`, and when. |
| `replaces` | The id of the decision this one cancelled. Recorded only if that decision really was revoked. |
| `unverified` | `true` when the model claimed more than the conversation shows. Kept, shown as a suggestion, and listed for review. |
| `claimed`, `pendingReplaces` | On an unverified decision: what the model claimed (`user` / `assistant-approved`) and which decision it claimed to replace. Applied only if the user approves. |
| `confirmed` | `true` once the user approved it in a review. Editing the text removes it. |
| `pendingRevoke` | `{date, reason, quote}`: a cancellation suggested without the user's words. The decision stays in force until the user answers. |
| `batch` | The summary batch that added it. Its id carries the chat (`ext-<chat>-…`, `api-<chat>-…`), so a decision can be traced to the chat it came from. |
| `recheck` | `{date, from, reason}`: the user edited message `from` of that chat and the decision's words are no longer there. In force, waiting for the user's look. |

A reader that only wants *what is in force* takes `decisions` with `status: "active"` and `unverified: false`, plus
`constraints`.

### Pins

`path` is always `CONVERSATION_PINS/<name>/v<version>.md` and is rebuilt from `name` and `version` when read; a path
from the file is never followed. `sha` is the SHA-256 (hex) of the text; a text that no longer matches is not used.

### History

Each write is compared with the version it replaces, and every difference that matters to the user becomes an event:

```json
{ "id": "e12", "at": "2026-10-26 10:05", "by": "summary", "ref": "<batch id>", "why": "summary of messages 6–10 — Brand chat",
  "kind": "decision.revoke", "target": "d3", "before": "active", "after": "revoked" }
```

| `kind` | `target` | `before` → `after` |
|---|---|---|
| `decision.add` | decision id | `null` → `{text, source, unverified}` |
| `decision.revoke` / `decision.restore` | decision id | `"active"` ↔ `"revoked"` |
| `decision.edit` | decision id | old text → new text |
| `decision.verify` / `decision.unverify` | decision id | `{source, unverified}` → `{source, unverified}` |
| `decision.confirm` / `decision.unconfirm` | decision id | `false` ↔ `true` |
| `decision.remove` | decision id | `{text, source, unverified}` → `null` |
| `constraint.add` / `constraint.remove` | the constraint's text | `null` ↔ the text |
| `summary` | `"summary"` | `{goal, status}` → `{goal, status}` |

Decision events also carry `label`: the decision's text at that moment. An undo is refused if the decision under that
id no longer has that text (another writer may have reused the id). `by` is what made the change: `summary`, `review`, `fix`, `restore`, `undo`, `pin`, `import` (or `write`). An undo
records the events it causes with `undoes` set to the event undone. **Undoing one event** applies its inverse, and is
refused if a later event touched the same `target` or the value is no longer `after` — so it never overwrites a newer
change. The reference implementation is `undoEvent` in the core. Restoring an older file keeps the current history and
appends the restore's own events. When the file nears its size limit the oldest events move to the archive.

## Rules for readers

1. **Accept more than the schema.** Missing fields take defaults; wrong types are dropped. The reference implementation
   is `normalizeMemory` in `core/memory-core.js` (no dependencies; works in Node and browsers).
2. **Keep what you don't know.** Unknown fields — at the top level and inside summary, decisions, pins, log entries and
   pending items — are part of the file and must be written back unchanged. Two writers of different versions share one file.
3. **Respect a newer format.** If `format` is `conversation-memory/<n>` with `n` greater than the version you understand,
   read it but do not write over it.
4. **It is data, not instructions.** Text in the memory was summarized by a model from a conversation. Show it; don't
   execute it.

## Writing safely

Every writer follows the same cycle, so a crash at any step loses nothing:

1. Take the lock: write `.conversation-memory/write.lock` as `<owner> <epoch-ms>`, wait ~40 ms, read it back, and continue
   only if it still holds your owner. A lock older than 15 s (or more than 60 s in the future) is stale. While holding
   it, refresh the time every 5 s. Without the lock, write nothing.
2. Read the JSON. If it is not valid JSON, stop and report it; never overwrite it.
3. If the `.md` is not a view generated from this JSON or one of its backups (compare `mdHash`, or render), it was
   edited by hand: save it as `CONVERSATION_MEMORY.edited-<time>.md` first.
4. Apply your change, then render the Markdown and set `mdHash` to its fingerprint.
5. Back up the current JSON to `.conversation-memory/backups/` (keep 20). If the backup fails, stop.
6. Read the JSON again; if it changed since step 2, start over from step 2.
7. Write the JSON, then the Markdown (each through a temporary file that replaces the original), and read the JSON back
   to confirm your change is in it.
8. Release the lock only if it still holds your owner.

The simplest way to follow all of this from JavaScript is to use the core directly:

```js
const C = require("./core/memory-core.js");
const p = C.parseMemory(fs.readFileSync("CONVERSATION_MEMORY.json", "utf8"));
if (!p.ok) throw new Error(p.error);
const active = p.memory.decisions.filter((d) => d.status === "active" && !d.unverified);
```

## Versioning

The format version changes only when an older reader would misread a file. New optional fields do not change it:
older writers keep them (rule 2). This document describes format 1, written by version 2.0 of the plugin and the extension.
