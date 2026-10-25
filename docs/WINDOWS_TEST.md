# التجربة الحية على Windows

تجربة حقيقية داخل Claude Code على جهازك: 11 رسالة قصيرة في مشروع تجريبي مؤقت، ثم 20 فحصاً لما حُفظ. تستغرق نحو 10 دقائق، وتستهلك قليلاً من استخدامك في Claude Code. لا تلمس مشاريعك: كل شيء في مجلد مؤقت يُنشأ لها.

## ما تحتاجه

- Claude Code مثبتاً ومسجّل الدخول. على Windows يتطلب Git for Windows، ومعه **Git Bash** الذي تجري فيه التجربة.
- Node.js 18 أو أحدث.

## الخطوات

افتح **Git Bash** (من قائمة ابدأ) والصق:

```bash
cd ~/Documents
git clone https://github.com/raednov101/conversation-memory.git cm-live-test
cd cm-live-test
npm install --no-audit --no-fund
npm run integration
```

## النتيجة

السطر الأخير يقول مثلاً `20 passed, 0 failed`. انسخ آخر 30 سطراً وأرسلها، أو افتح بلاغاً بها في
[صفحة المشاكل](https://github.com/raednov101/conversation-memory/issues/new?template=bug.yml).

بعدها يمكنك حذف المجلد `Documents\cm-live-test`.
