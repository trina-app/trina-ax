# A final answer's English working notes are not the answer

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (adds to 20261122-interim-text-not-answer.md)
- Branch: fix/final-answer-english-lead (the owner, QA f1/f4 runs 11-22)

- **Ask:** after #329 and #364 the AI's English notes between calls left Korean answers, but the note it writes after
  the last call still opened them: "Need a venv.", "Chromium didn't produce PNGs; use make_file instead.", "Install
  python-docx in a venv.", "Good result. Saving it.", "Quick check of the result." No phrase list: new ones keep coming.
- **Rule:** where the answer's language is Korean, Japanese or Chinese (chat/narration.ts leadScript: narrationScript on
  the person's own words, quote lines left out), the final text piece's leading paragraphs (split on blank lines) that
  have no Hangul, kana or CJK character, are under 160 characters, have a Latin word, end in a sentence mark (. ! ? :)
  and are no code (fenced, indented, inline, or with a command's or query's symbols), link, quote, list item, table row,
  heading, bold line alone or file name alone, and are not the person's own words,
  leave the answer (a stream reset, so live and saved agree) and become a thinking step, as an interim piece does.
  Guards: never the whole answer, and only when the rest has the answer's script (an English answer stays whole); off
  when the person asks for another language ("영어로", "in English", "英語で", "英文": the interim rule's list), in this
  message or the one before it (a follow-up to an English draft: "좀 더 짧게"), or writes
  mostly in Latin letters (more letters of Latin words than twice the CJK characters). Both engines end their turn
  in the same place (chat/turn.ts dropFinalLead, after the interim fallback).
- **Why:** shape and position, not wording. The answer's own content in English (a title, a product name) sits in the
  same paragraph as Korean words or is marked up as content; a bare short English paragraph above a Korean answer is a
  note the AI wrote to itself.
- Left out: a bare command alone with no markup or symbols ("npm run build") and no sentence mark stays (it has none);
  one that ends in "." is taken as a note. CRLF text is not split (nothing is dropped).
- **Tests:** tests/unit/final-answer-lead.test.ts.
- **Version impact:** patch.
