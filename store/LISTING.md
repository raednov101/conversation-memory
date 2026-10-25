# بيانات النشر في متجر Chrome — ذاكرة المحادثة 1.5.0

كل ما يطلبه نموذج النشر في [لوحة مطوّري متجر Chrome](https://chrome.google.com/webstore/devconsole)، جاهزاً للنسخ.

## الملف

`downloads/conversation-memory-extension-1.5.0.zip`: يُرفع كما هو.

## بطاقة المتجر

| الحقل | القيمة |
|---|---|
| الاسم | ذاكرة المحادثة لـ ChatGPT وClaude (من الملف) |
| الفئة | Productivity (الإنتاجية) |
| اللغة | العربية |
| الأيقونة | `extension/icons/128.png` |
| الصور (1280×800) | `store/screenshot-1.png` إلى `store/screenshot-5.png` |
| الصورة الترويجية الصغيرة (440×280) | `store/promo-440x280.png` |
| رابط الدعم | https://github.com/raednov101/conversation-memory/issues |
| الموقع | https://github.com/raednov101/conversation-memory |

### الوصف القصير (من الملف، 120 حرفاً)

يلخّص محادثاتك في ChatGPT وClaude ويحفظ ذاكرة كل مشروع داخل المتصفح أو في مجلد تختاره. غير تابعة لـ OpenAI أو Anthropic.

### الوصف الكامل (عربي)

```
النقاش الطويل لا يضيع.

كل 10 رسائل منك (أو العدد الذي تختاره) تلخّص «ذاكرة المحادثة» ما نوقش وتقرر في محادثتك على chatgpt.com أو claude.ai، وتحفظه ذاكرةً للمشروع: الهدف والوضع الحالي، والقرارات ومن اتخذها، والقيود، والنصوص التي اعتمدتها حرفياً. وفي محادثة جديدة تُدرج الذاكرة بضغطة، فتكمل من حيث توقفت.

ما تجده فيها:
• لكل مشروع في ChatGPT أو Claude ذاكرته، تُحفظ داخل متصفحك تلقائياً بلا إعداد.
• النص الكامل للمحادثة يُحفظ بعد كل رد.
• تثبيت نص حرفياً: حدّد النص ثم «ثبّت النص المحدد»، بنسخ مرقّمة وبصمة.
• نقل أجزاء مختارة إلى محادثة أخرى، بمعاينة وطول قبل الإدراج، دون إرسال.
• تراجع عن آخر تغيير، وآخر 20 نسخة سابقة.
• نسخة كاملة في ملف واستعادتها.
• كل قرار بمصدره وتاريخه، ومعه اقتباس من كلامك تتحقق منه، ولا يصير مؤكَّداً إلا بموافقتك. وما لا يثبت من كلامك، أو أي إلغاء أو تغيير لما قررته بلا كلامك، لا يُطبَّق حتى تراجعه.
• اختيارياً بمفتاحك من Anthropic أو OpenAI: التلخيص في الخلفية، فلا يظهر شيء في المحادثة.
• شارة صغيرة تقول لك الحالة: كم بقي حتى التلخيص، وهل حُفظ، ولماذا تعثّر إن تعثّر.

الخصوصية:
• لا خادم للمطوّر، ولا حساب، ولا إحصاءات.
• تُحذف المفاتيح وكلمات المرور الشائعة قبل الحفظ.
• التلخيص يرسل رسالة باسمك في المحادثة نفسها، فيصل نص الذاكرة إلى ChatGPT أو Claude كأي رسالة تكتبها، ويُحتسب من رصيد رسائلك.

تعمل مع بلقن «ذاكرة المحادثة» لـ Claude Code بالصيغة نفسها، إن ربطتها بمجلد مشروعك.

الواجهة بالعربية. المشروع مفتوح المصدر (MIT) وغير تابع لـ OpenAI أو Anthropic.
```

### Full description (English)

```
Long conversations, not forgotten.

Every 10 of your messages (or the number you choose), Conversation Memory summarizes what was discussed and decided in your chat on chatgpt.com or claude.ai and keeps it as the project's memory: the goal and current state, the decisions and who made them, the constraints, and texts you approved word for word. In a new chat, insert the memory with one click and continue where you left off.

• Each ChatGPT or Claude project gets its own memory, kept inside your browser, no setup.
• The full transcript is saved after every reply.
• Pin a text verbatim, with numbered versions and a fingerprint.
• Carry chosen parts to another chat, previewed before insertion, never sent for you.
• Undo the last change; the last 20 versions are kept. Full backup to a file and restore.
• Every decision carries its source, date and a quote of your own words you can check; it is marked confirmed only when you approve it. Anything your words do not back, including revoking a decision or changing a constraint, is not applied until you review it.
• Optional: with your own Anthropic or OpenAI key, summaries run in the background and nothing appears in the chat.

Privacy: no developer server, no account, no analytics. Common keys and passwords are removed before saving. Summarizing sends a message as you in the same chat, so the memory text reaches ChatGPT or Claude like any message you type, and counts toward your usage.

Arabic interface. Open source (MIT). Not affiliated with OpenAI or Anthropic.
```

## الخصوصية (تبويب Privacy practices)

### الغرض الوحيد (Single purpose)

حفظ ذاكرة مختصرة للمحادثات الطويلة في chatgpt.com وclaude.ai، وإدراجها في محادثة جديدة.

### مبررات الصلاحيات

| الصلاحية | المبرر (يُلصق كما هو) |
|---|---|
| `storage` | Stores the user's settings and each chat's progress (how many messages were summarized), locally. |
| `offscreen` | An offscreen document reads and writes the memory files in the extension's own origin storage, or in a folder the user linked; file handles cannot be used from the service worker. |
| `contextMenus` | Adds "Pin selected text" to the right-click menu on chatgpt.com and claude.ai, to save a selected text verbatim. |
| Host access (content scripts on chatgpt.com, chat.openai.com, claude.ai) | Reads the conversation on the page to summarize it, shows the status indicator, and types the summary request or the memory into the message box. |
| Optional host access (api.anthropic.com, api.openai.com) | Requested only when the user saves their own API key, for the provider they chose, to summarize in the background instead of in the chat. Removed when the key is deleted. |
| Remote code | **No.** All code is in the package. |

### البيانات (Data usage)

- **ما يُجمع:** اختر **Website content**، لأن الإضافة تقرأ نص المحادثة في الصفحة. واختر **Authentication information**، لأنها تحفظ مفتاح API إن أضافه المستخدم (اختياري، محلياً)، وتستخدم رمز جلسة ChatGPT لقراءة المحادثة من الموقع نفسه حين تتعذر قراءة الصفحة. لا يُرسل شيء من ذلك للمطوّر.
- **أقرّ بالثلاثة:**
  - لا بيع للبيانات ولا نقلها لطرف ثالث خارج الاستخدامات المسموحة.
  - لا استخدام لها في غير الغرض الوحيد.
  - لا استخدام لها لتقييم الأهلية الائتمانية.
- **رابط سياسة الخصوصية:** https://github.com/raednov101/conversation-memory/blob/main/PRIVACY.md

## قبل الضغط على «إرسال للمراجعة»

- [ ] حساب مطوّر في متجر Chrome (رسم تسجيل لمرة واحدة).
- [ ] رفع الملف، وتعبئة الحقول أعلاه، ورفع الصور.
- [ ] الظهور: «عام» أو «غير مدرج» للتجربة مع عدد محدود أولاً.
