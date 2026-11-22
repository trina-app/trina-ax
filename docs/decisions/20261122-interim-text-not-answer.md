# Text a tool call follows is the AI's narration, not the answer

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (narrows docs/decisions/20261116-answer-no-english-narration.md and 20261117-answer-work-notes.md to a second guard)
- Branch: fix/ai-honesty-qa-1122 (the owner, live examples; QA TC-r2u-01/06/16/29, TC-r2b-05)

- **Ask:** English lines the AI wrote to itself between tool calls ("Now the SKILL.md.", "Quick speed test on a short
  stretch first:", "Encoding is wrapping up.", "Good result. Saving it.") stayed in Korean answers, live and saved, on
  Claude Code and the API engine. The word-pattern filter kept missing new ones.
- **Rule:** where the answer's language is not written in Latin letters (Korean, Japanese, Chinese) and the person did
  not ask for another language (chat/narration.ts narrationScript), a text piece of the main AI that a tool call of the
  main AI follows is interim. When the call starts, the
  piece leaves the answer (the stream gets a reset at its offset, so live and saved agree) and becomes the detail of a
  thinking step. Only the text after the last call is the answer. If nothing follows the last call, the last interim
  piece that is not a status line is the answer, so it is never blank. A turn with no calls is unchanged. Elsewhere (English, a Latin-letter message) the text between calls stays, as in
  Claude Code, and only the pattern guard applies: there it is at least in the person's language. A sub-agent's
  calls do not end the main AI's piece; neither do bookkeeping calls (a title, a to-do list, remember / forget), so
  "answer, then remember" keeps the answer, and a piece copied into the call's arguments (a message it posts, a file it
  writes) stays as content. Both engines' events go through the same place (chat/turn.ts endPiece).
- **Why:** position, not wording, tells narration from the reply. Claude Code's own CLI shows text between calls as
  progress, and the final message as the result.
- The pattern filter (chat/narration.ts) stays as a second guard: it still keeps status lines out while a piece streams
  and before a thinking block, and out of the fallback.
- **Tests:** tests/unit/narration-hold.test.ts (a Korean final reply with English pieces between calls, no calls, an
  empty final reply, a stop, a sub-agent).
- **Version impact:** patch.
