# A final answer's English working notes leave a Korean, Japanese or Chinese answer

- Date (UTC): 2026-11-22 08:10
- Branch: `fix/final-answer-english-lead`
- Status: done
- Where: server/src/chat (narration.ts, turn.ts). Why: the AI's English notes to itself still open Korean answers.
- Version impact: patch, a bug fix in how the answer text is kept.

## Goal

#329 and #364 took the AI's text between tool calls out of the answer. The line it writes after the last call stays:
"Need a venv.", "Chromium didn't produce PNGs; use make_file instead.", "Good result. Saving it.", "Quick check of
the result." at the top of a Korean answer (owner, many times; QA f1/f4 runs 11-22).

## Scope

In: a structural rule, no phrase list. Where the answer's language is Korean, Japanese or Chinese (the same detection
as #329, on the person's own words without quote lines as #364), the final answer's leading paragraphs that have no
CJK character, are short (under 160 characters), and are no code, link, quote, list item, table row, heading or file
name alone leave the answer as a thinking step. Never the whole answer; never when the rest has none of the script;
off when the person asks for English ("영어로", "in English", "英語で", "英文") or writes mostly in Latin letters. Both
engines, live (a stream reset) and saved.
Out: a single-line English title above Korean in the same paragraph (kept on purpose).

## Steps

1. narration.ts: `leadScript`, `finalAnswerLead`.
2. turn.ts: `dropFinalLead` at the end of the turn, after the interim fallback.
3. Tests: tests/unit/final-answer-lead.test.ts; decision file; changes note.
4. Checks on the Mac mini, a fresh review, a real claude-code run on a QA copy (3 Korean box_shell requests).

## Decisions

docs/decisions/20261122-final-answer-english-lead.md

## Result

As planned, plus review fixes: inline code and a command's or query's symbols count as content, a note must end in a
sentence mark (titles, product names and totals stay), a follow-up to a request for an English draft is off, and a
card inside the final piece keeps its place. Checks (Mac mini, Bun 1.3.12): typecheck, check:prepush, narration area
tests (11 files). Real claude-code run on a private QA copy: 3 Korean box_shell requests (python-docx, primes,
matplotlib PNG), all three answers open in Korean; the English notes between calls are thinking steps.
