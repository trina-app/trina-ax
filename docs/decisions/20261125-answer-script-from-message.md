# The answer's script comes from the person's message, not only the app language

- Date: 2026-11-25
- Status: accepted
- Supersedes: none (narrows "Off" in [20261116-answer-no-english-narration.md](20261116-answer-no-english-narration.md))
- Branch: fix/ko-answer-english-notes (night figure eval on dev 8150616b3, prompt F7 run 0)

- **Ask:** an English app, a Korean question ("한국의 고령화 현황 … 브리핑으로 정리해줘"), a Korean answer. The saved
  answer (`Message.content`: copy, export, room send, notices) opened with the AI's pieces between calls, one in
  English: "The 2026 report exists; I'll read the original press release." The rules that keep those out of a
  Korean, Japanese or Chinese answer (20261116, 20261122, 20261125, the final answer's English lead) were keyed on the
  app language, so none ran.
- **Rule:** the answer's script (chat/narration.ts narrationScript, leadScript) is the script of the person's own
  words (quote lines left out): Hangul that outweighs kana and Chinese characters is Korean, kana is Japanese,
  characters alone are Japanese in a Japanese app and Chinese otherwise; a message mostly in Latin letters has none.
  This holds in any app language, so a Korean question in an English app is treated as in a Korean app, and a
  Japanese question in a Korean app as in a Japanese one. A short or mixed message ("ok", a file) follows the message
  before it, else the app language, as before; in a Latin-letters app only a message with no Latin word does ("👍",
  a file), since "ok" or "Yes please" there is English and may get an English answer. Everything else is unchanged: asking for another language or a
  translation, text often in English, 3 or more Latin words turn it off; an English message in any app is untouched.
- **Why:** the AI answers in the language of the latest message (prompt.ts answerLanguageLine), so the app language
  only told the answer's language when the person wrote in it. 20261116 turned the hold off for Latin-letter apps
  because script cannot tell a status line from a Latin answer; that reason does not hold for an answer in Hangul.
- **Tests:** tests/unit/narration-hold.test.ts (narrationScript by message, the real turn in an English app),
  tests/unit/final-answer-lead.test.ts.
- **Version impact:** patch.
