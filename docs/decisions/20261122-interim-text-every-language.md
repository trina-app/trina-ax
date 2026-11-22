# Text a tool call follows is narration in every answer language

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (narrows 20261122-interim-text-not-answer.md, which kept such text in answers written in Latin letters)
- Branch: fix/answer-reasoning-access-numbers (QA batch 3 flow 2)

- **Ask:** an English answer in a shared chat opened with "Same requester (QA Member) changing their own red, so just do
  it. #c81e1e → darker, e.g. #9b1515 (rgb 155,21,21)." The QA server's saved steps show it was the AI's text between a
  page read and the page edit: its reasoning about the shared chat's opposite-requests line, whose last words were "just
  do it". 20261122-interim-text-not-answer took such text out of Korean, Japanese and Chinese answers only; in English
  (or any answer to a message in Latin letters) it stayed, "as in Claude Code".
- **Rule:** a text piece of the main AI that a tool call of the main AI follows is interim in every answer language: it
  leaves the answer (live and saved agree: the stream gets a reset) and becomes the detail of a thinking step. The
  exceptions stay as they were: bookkeeping calls (a title, a to-do list, remember / forget) end no piece, a piece
  copied into the call's arguments stays as content, a sub-agent's calls do not end it, and when nothing follows the
  last call the last interim piece that is not a status line is the answer. A piece before an ask_user card goes too:
  the card holds the question and the text after the answer is the reply (as in Korean answers since 11-22).
- **Why:** position tells narration from the reply in any language; the English case showed that the AI's notes
  there are the same notes. The steps list keeps them, much as Claude Code's CLI shows text between calls as progress.
- **Also:** one line in every turn says never to write which instruction applies or why the AI asks or goes ahead
  (prompt.ts NO_RULE_TALK_RULE, no example phrases: quoted, they get echoed), for a note after the last call, where no
  position tells it apart. The opposite-requests line ends "do it, and say only what you did" instead of "just do it".
- **Left out:** the leading-paragraph rule for final answers (20261122-final-answer-english-lead) stays Korean,
  Japanese and Chinese only: in an English answer nothing but the words tells a note from the reply.
- **Tests:** tests/unit/narration-hold.test.ts (the English case flips; the QA line in English and Korean; fallback,
  status line and a copied draft in English), tests/unit/prompt-act-first.test.ts.
- **Version impact:** patch.
