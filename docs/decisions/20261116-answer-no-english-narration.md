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
  (or before the first one). In an answer whose language has its own script (app language ko, ja or zh), a piece is
  held while it could still be a status line: it is not streamed and not saved. The next event decides it:
  - a tool call of the main AI (or a thinking block: more comes after it) drops it only when **all** hold:
    - it reads as work in progress (second review round of #1066: only signs that are almost never content):
      "let me / I'll / I will" with a working verb (check, look, search, read, open, find, verify, rename, …; not
      "check in", "check out", "look forward"), "now" with a working gerund ("Now renaming."), a working gerund with an
      object ("Checking the folder", "Reading the price list", not "Reading list for the week"), "Found it", "Verify:"
      alone; or, after "," or ";", a plan ("…, so I'll match it.") or an order to itself ("…; check it.", not "check
      it out"); or "the user" with what they want ("the user asked …");
    - nothing marks it as content: no "?" or "!", not "Let me know / Let me introduce / I'm happy … / I am writing /
      Looking forward / Following up / out of office";
    - it is ASCII once file names (quoted or not) and `code` are taken out (typographic dashes and apostrophes count);
      it is short (at most 200 characters, 2 sentences, 2 lines); it has no link or address, no Markdown, no quote
      marks and no number with a unit or currency. The dropped piece's separator takes the place of the next one's;
  - anything else lets it out at once, as it was ("Hi team, the deploy is done.", "Total: 42 files", "## Results",
    "Hola equipo, ya está listo." are content, not status lines: review of #1066);
  - a sub-agent's tool call leaves the main AI's piece undecided;
  - the end of the answer lets out what is held. The last piece is never dropped: an English email the person asked
    for in a Korean chat is the answer, written after the last call. A stop or an error with a status line held drops
    it like a call does. When the engine streamed nothing and only its whole text is left, that text is not used once
    a line was dropped (it contains the line).
- **Off** when the app language uses Latin letters (en, id, es: script cannot tell a status line from the answer), when
  the message asks for another language or a translation (영어, 영문, 번역, …어로 / …말로 / …어 버전, …語で, 用…语,
  English, translate, Spanish, Japanese …) or for text often written in English (영작, 슬로건, 카피, 문구, 캐치프레이즈,
  커밋 / commit, 버튼, 라벨), when it quotes 3 or more English words (after ":" or in quotes), and when the message is written in Latin words (3 or more, none of the app
  language's script: it gets an answer in that language). A short or mixed message ("ok", "👍", an attachment, pasted
  English with a Korean question) follows the person's message before it, else the app language.
- **The stream:** what is held is not sent yet, what is dropped is never sent, so the streamed text and the saved
  answer are the same (no "reset" of text the person already saw). The cost is a short delay: at most 200 characters
  of a Latin-only piece wait for the next event; Korean text goes out as soon as a whole Korean word is there.
- **Why not the prompt alone:** the rule was in the prompt and the model still wrote the lines (random, a few cases a
  run). Sub-agents' text never reached the answer, so only the main AI's pieces are held.
- **Known gap (the safe way to be wrong):** status lines that only describe or open like content are kept:
  "Following the existing naming pattern (매장-전경.jpg).", "Existing pattern: …", "User's own dictated words.", "The
  Saturday delivery question is in the thread under …". Of the 10 different lines the scenario runs leaked into Korean
  answers (first run and runs 2–10), 4 are dropped by this rule ("Only one thread exists; check it.", "Let me check that
  the seal printed correctly.", "…, so I'll match it.", "…; check it.") and 6 are kept; `tests/unit/narration-hold.test.ts`
  lists both. Dropping a line the person needed is worse than
  keeping a stray one.
- **Not done:** a status line in the answer's own language is kept ("파일을 확인할게요."). A short English line asked for
  without saying "English", written before a tool call, is dropped (rare: the AI writes such content as the final answer
  or into a file). The log says how many pieces an answer dropped (`status lines left out of the answer`), never their
  text.
- Tests: `tests/unit/narration-hold.test.ts` (the hold on its own; two real turns through the fake engine: Korean drops
  the line, English keeps it, the stream equals the saved answer).
- Version impact: patch (no API, no migration).
