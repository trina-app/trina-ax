# Text between tool calls shows at its place among the steps

- Date: 2026-11-25
- Status: accepted
- Supersedes: none (narrows [20261122-interim-text-not-answer.md](20261122-interim-text-not-answer.md): where an
  interim piece shows, not what the answer text holds)
- Branch: fix/interim-text-inline (the owner; qa.trina.app example chats of 11-25)

- **Ask:** what the AI writes between tool calls ("Nothing relevant yet. Let me widen the search…") sat at the top of
  the answer above every step (English and other Latin-letter answers) or was folded away in a "Thinking" step (Korean,
  Japanese, Chinese). Claude Code shows it in order, between the calls.
- **Rule:** in every language the answer reads in the order of the work: a group of steps, the text written after it,
  the next group, …, the final answer. A group that is done folds into one "N steps" line; while the answer runs the
  last group shows live and the earlier ones fold. The answer's text is cut where each step started (`Step.textAt`,
  the same block-safe cut the artifact cards use: never inside a paragraph, list, quote or code block), so answers
  saved before this change read in order too; steps without `textAt` stay above the text. An interim piece that left
  the answer (a Korean, Japanese or Chinese answer, 20261122) and is written in the answer's own script is marked
  `Step.interim` and shows as text at its step's place. A working note in other letters (an English status line in a
  Korean answer, the final answer's English lead) stays a folded thinking step. When the last piece falls back to
  being the answer, its step loses the mark, so the text never shows twice. Artifact cards go right after the step
  that made them.
- **Shared chats:** an interim step's text reaches everyone who sees the answer (ChatStore.viewSteps), as the answer's
  own text does; a thinking block's text stays the runner's.
- **Not changed:** what `Message.content` holds. Copy, exports, room sends, notifications and the AI's history use it
  as before: in Korean, Japanese and Chinese the final answer only; elsewhere the answer as written.
- **Why:** position tells progress from the result; one rule for every language; Claude Code is the floor. No new
  card or button: the folded step lines are the ones there were, one per group.
- **Mobile:** the app shows the web app; nothing of its own.
- **Tests:** web/test/unit/answer-flow.test.tsx, web/test/unit/artifact-placement.test.tsx,
  tests/unit/narration-hold.test.ts (the interim mark, the fallback), tests/unit/interim-step-view.test.ts.
- **Version impact:** patch.
