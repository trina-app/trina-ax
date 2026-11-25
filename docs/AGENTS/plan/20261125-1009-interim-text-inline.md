# Text between tool calls shows at its place among the steps

- Date (UTC): 2026-11-25 10:09
- Branch: `fix/interim-text-inline`
- Status: in progress
- Where: web (chat answer view), server (chat/turn.ts interim pieces, chat/store.ts shared view). Why: the answer view
  is web; the interim piece is made in the turn (see docs/REPOSITORY-RULES.md)
- Version impact: patch: how an answer is laid out; no API removed, one optional Step field added

## Goal

What the AI writes between tool calls ("Nothing relevant yet. Let me widen the search…") should read where it was
written, between the steps, as Claude Code shows it. Today it sits at the top of the answer above every step (English
and other Latin-letter languages: the text stays in the answer, the steps fold into one line above it) or is folded
away inside a "Thinking" step (Korean, Japanese, Chinese: docs/decisions/20261122-interim-text-not-answer.md).

## Scope

In:
- Web: the answer is one flow in the order the work happened: a group of steps (folded into one "N steps" line when
  done, live while it runs), the text written after it, the next group, … , the final answer. The text is cut by each
  step's `textAt` (the same block-safe cut the artifact cards use), so answers saved before this change read in order
  too. Artifact cards go right after the step that made them (as now: after their caption).
- Server: a Korean/Japanese/Chinese interim piece in the person's script is marked `interim` on its thinking step; the
  web shows it as text at its place, not folded. A working note in another script (an English status line in a Korean
  answer, the final answer's English lead) stays a folded thinking step. When the last piece falls back to being the
  answer, its step loses the mark (no text twice).
- Shared chats: the other people see an interim step's text, as they see the answer text.
- Mobile: the app shows the web app (no own answer view): nothing to change.

Out: changing what the answer text (Message.content) holds. Copy, exports, room sends and notifications keep using it
as today (CJK: the final answer; Latin: the answer as written).

## Steps

1. shared `Step.interim` (optional), server endPiece / endInterimFallback, store viewSteps keeps an interim step's
   detail for every viewer.
2. web `lib/answerFlow.ts`: steps + content → items (steps group, text, interim note, cards); Messages.tsx renders it.
3. Unit tests: web flow (Latin legacy, CJK interim, streaming, cards, code blocks), server narration-hold mark.
4. Decision file, changes file, screenshots 1440/390 light/dark.

## Decisions

docs/decisions/20261125-interim-text-inline.md (narrows 20261122-interim-text-not-answer.md: where the piece shows).

## Risks

No migration. Older apps see an interim step as a Thinking row (as today). Five app languages: no new strings.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit tests, tests/unit/narration-hold.test.ts, b-step-text-at.

## Result

(at the end)
