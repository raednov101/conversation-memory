# Conversation Memory 2.0 — for Claude, ChatGPT and Claude Code

[العربية](README.md)

Long discussions don't get lost. Your chat is summarized into a memory for the project: the goal and current status,
the decisions and who made them, the constraints, and the texts you approved word for word. Pick up from it in a new
session or on another platform.

| | Conversation Memory | Built-in memory in ChatGPT or Claude |
|---|---|---|
| Decisions | Numbered, dated, with their source and a quote of your own words that is checked. Nothing becomes "confirmed" without your approval; what isn't backed waits for your review | General notes, no source |
| Changes | A history of every change: when, what made it, why. Undo a single change | No history |
| Important text | Kept verbatim, versioned, fingerprinted | Rephrased |
| Across platforms | One memory for ChatGPT, Claude and Claude Code; Gemini (experimental) | Each platform alone |
| Where it lives | Files you can read, move and roll back | Inside the platform's account |

## Parts

| Part | Runs in | Memory kept |
|---|---|---|
| Claude Code plugin | Claude Code (CLI) | In your project folder |
| Browser extension | chatgpt.com and claude.ai in Chrome and Edge; gemini.google.com (experimental, opt-in) | Inside the browser, one memory per site project (or per chat outside projects); optionally in a folder shared with the plugin |

Both share one core library (`core/memory-core.js`, byte-identical in both packages) and write the same format.

## Install

**Plugin**, inside Claude Code (Node.js 18+):

```
/plugin install conversation-memory --marketplace raednov101/conversation-memory
```

**Extension:**
1. Download [conversation-memory-extension-2.0.0.zip](https://github.com/raednov101/conversation-memory/raw/main/downloads/conversation-memory-extension-2.0.0.zip) and unzip it.
2. In `chrome://extensions` turn on Developer mode.
3. Choose "Load unpacked".

The interface follows your browser's language (Arabic or English), or the one you pick in the settings.

## For developers

- **File format:** [docs/FORMAT.md](docs/FORMAT.md) and a JSON Schema at [docs/schema/conversation-memory-1.schema.json](docs/schema/conversation-memory-1.schema.json). Read or write the memory from any tool; the rules for doing it safely are there.
- **Architecture and decisions:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), in Arabic.
- **How accurate the checks are:** [tests/eval/README.md](tests/eval/README.md). Held-out sets were labelled by authors who never saw the rules; the results are published as measured, including where 2.0 is not better.
- **Tests:**
  - `npm test`: 151 unit tests.
  - `npm run e2e`: 229 checks in Chromium.
  - `npm run integration`: a live Claude Code run.

## Privacy

- **No developer server.** No usage is collected.
- **The memory text reaches the model** when you summarize or insert it, like any message you type.
- **Secrets are removed** before saving. The scan catches common patterns and is not complete.

Full policy: [PRIVACY.md](PRIVACY.md).

## Limits

- **The summary is written by a model.**
  - The system checks that each decision attributed to you quotes your words and that its numbers appear.
  - That catches some contradictions. It does not guarantee the meaning.
  - For important text, use verbatim pinning.
- **Without your own API key, the extension's summary request appears in the chat.** It counts toward your message allowance.

[MIT](LICENSE). Not affiliated with OpenAI, Anthropic or Google.
