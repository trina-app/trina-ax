# English status lines before a tool call stay out of Korean, Japanese and Chinese answers

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/answer-no-english-narration (AI scenario check 2026-11-16, root cause #8)

Plan: docs/AGENTS/plan/20261116-0459-answer-no-english-narration.md.

- **Ask:** the AI scenario check found Korean answers that start with an English line: "Only one thread exists; check
  it." (ROOM-03), "Let me check that the seal printed correctly." (EDIT-04, FLOW-01), "Following the existing naming
  pattern (매장-전경.jpg)." (ORG-01). They are the model's own text written right before a tool call. The answer keeps
  every text piece the engine writes, so they reached the person. LANGUAGE_RULE (chat/prompt.ts) already says not to
  write them and did not hold.
- **Rule:** a hold in front of the answer text (`server/src/chat/narration.ts`, used by `chat/turn.ts` for every
  engine: Claude Code, Codex, the API engine). A *piece* is the text the main AI writes between two of its tool calls
  (or before the first one). In an answer whose language has its own script (app language ko, ja or zh, and the
  person's message written in it), a piece is held while it could still be a status line: it is not streamed and not
  saved. The next event decides it:
  - a tool call of the main AI drops it when it is short (at most 200 characters, 2 sentences, 2 lines), has Latin
    letters and none of the answer's script (a file name or `code` in it does not count), and is not content: no code
    block, quote marks, `> ` quote, link or table. The dropped piece's separator takes the place of the next one's;
  - anything else (Korean words, longer text, content) lets it out at once, as it was;
  - the end of the answer lets out what is held. The last piece is never dropped: an English email the person asked
    for in a Korean chat is the answer, written after the last call.
- **Off** when the app language uses Latin letters (en, id, es: script cannot tell a status line from the answer),
  when the message is not written in the app language's script (a Korean app, a question in English, gets an English
  answer), and when the message asks for English or a translation (영어, 영문, 번역, English, translate, 英語, 英文,
  英语, 翻訳, 翻译): a short English line written before a tool call is then what was asked for (e.g. a sentence posted
  to a room).
- **The stream:** what is held is not sent yet, what is dropped is never sent, so the streamed text and the saved
  answer are the same (no "reset" of text the person already saw). The cost is a short delay: at most 200 characters
  of a Latin-only piece wait for the next event; Korean text goes out as soon as a whole Korean word is there.
- **Why not the prompt alone:** the rule was in the prompt and the model still wrote the lines (random, a few cases a
  run). Sub-agents' text never reached the answer, so only the main AI's pieces are held.
- **Not done:** a status line in the answer's own language is kept ("파일을 확인할게요."). A short English line asked for
  without saying "English", written before a tool call, is dropped (rare: the AI writes such content as the final answer
  or into a file). The log says how many pieces an answer dropped (`status lines left out of the answer`), never their
  text.
- Tests: `tests/unit/narration-hold.test.ts` (the hold on its own; two real turns through the fake engine: Korean drops
  the line, English keeps it, the stream equals the saved answer).
- Version impact: patch (no API, no migration).
