# Store listing texts for 2.0.0 (Chrome Web Store and Microsoft Edge Add-ons)

Paste into the store dashboards after 1.4.0 is approved. Name and short description come from the extension's own
`_locales` (Arabic default, English for English browsers).

## العربية

**الاسم:** ذاكرة المحادثة لـ ChatGPT وClaude

**وصف قصير (132 حرفاً كحد أقصى):**
يلخّص محادثاتك في ChatGPT وClaude ويحفظ ذاكرة كل مشروع داخل المتصفح أو في مجلد تختاره. غير تابعة لـ OpenAI أو Anthropic.

**الوصف الكامل:**

النقاش الطويل لا يضيع. كل 10 رسائل تلخّص الإضافة ما طُرح وتقرّر في ذاكرة للمشروع: الهدف والوضع، والقرارات ومن اتخذها، والقيود، والنصوص التي اعتمدتها حرفياً. وفي محادثة جديدة تُدرج الذاكرة بضغطة.

ما يميزها:
- كل قرار معه اقتباس من كلامك يُتحقق منه. ما لا يثبت ينتظر مراجعتك، ولا يصير «مؤكَّداً» إلا بموافقتك. الفحص يكشف بعض صور التعارض، ولا يضمن صحة تفسير المعنى.
- سجل لكل تغيير في الذاكرة: متى ولماذا، مع التراجع عن تغيير واحد دون غيره.
- ذاكرة واحدة بين ChatGPT وClaude وبلقن Claude Code، وGemini تجريبياً.
- كل شيء عندك: داخل المتصفح، أو في مجلد على جهازك. لا خادم للمطوّر ولا جمع لأي استخدام.
- بالعربية والإنجليزية.

للعلم: طلب التلخيص يظهر في المحادثة ويُحتسب من رصيد رسائلك، إلا إذا أضفت مفتاحك من Anthropic أو OpenAI فيُلخَّص في الخلفية.

## English

**Name:** Conversation Memory for ChatGPT and Claude

**Short description (max 132 characters):**
Summarizes ChatGPT and Claude chats into a memory per project, in your browser or folder. Not affiliated with OpenAI or Anthropic.

**Full description:**

Long discussions don't get lost. Every 10 messages the extension summarizes what was raised and decided into a memory for the project: the goal and status, decisions and who made them, constraints, and texts you approved word for word. In a new chat, insert the memory with one click.

What sets it apart:
- Every decision carries a quote of your own words, and that quote is checked. What isn't backed waits for your review, and nothing becomes "confirmed" without your approval. The check catches some contradictions; it does not guarantee the meaning.
- A history of every change to the memory: when and why, with undo for a single change.
- One memory across ChatGPT, Claude and the Claude Code plugin, and Gemini (experimental).
- Everything stays with you: in your browser, or in a folder on your computer. No developer server, no usage collection.
- In Arabic and English.

Note: the summary request appears in the chat and counts toward your message allowance, unless you add your own Anthropic or OpenAI key, which summarizes in the background.

## Microsoft Edge Add-ons notes

- **Package:** upload the same zip (`conversation-memory-extension-2.0.0.zip`).
- **Category:** Productivity.
- **Privacy policy URL:** the same `PRIVACY.md` link as the Chrome listing.
- **Permissions to justify:**
  - `storage`: settings and the memory inside the browser;
  - `offscreen`: the writer that reads and writes the memory;
  - `contextMenus`: the "pin selected text" item;
  - `scripting`: runs on Gemini only after the user turns it on;
  - optional hosts: the user's own API provider and gemini.google.com, both asked for at the moment they are used.
- **Test instructions for reviewers:**
  1. Open chatgpt.com or claude.ai and start a new chat.
  2. After 10 messages, the extension sends a summary request and saves the reply.
  3. The 🧠 badge at the bottom of the page shows its state.
  4. The settings page shows the memory, its history and earlier versions.
