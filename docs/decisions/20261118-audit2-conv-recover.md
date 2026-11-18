# A full conversation goes on in the same answer, not in a new chat

- Date: 2026-11-18
- Status: accepted
- Supersedes: the "context" error of "Official chat failures" (docs/DECISIONS.md, 2026-10-21), which ended the answer
  with "Please continue in a new chat"
- Branch: fix/audit2-conv-recover (limits audit 2 #13, QA TC-4925)

Plan: docs/AGENTS/plan/20261118-1130-audit2-conv-recover.md.

- **Ask:** a long chat ended the answer with "This conversation got too long. Please continue in a new chat." with no
  restart, and any engine error with the word "context" in it ("Execution context was destroyed", a tool's "context"
  field) counted as a full conversation. Claude Code compacts and goes on. The person should never have to start a new
  chat.
- **Rule, what counts:** only what the providers say when the conversation does not fit (`CONTEXT_FULL` in
  `engine/claude-parse.ts`): "prompt is too long", "context window / length / limit", "context_length_exceeded",
  "maximum context", "too many tokens", "conversation too long", "request_too_large" (a fresh start sends less). It is
  tested before the limit check, and the limit's "429" must be a word of its own: "Prompt is too long: 214290 tokens"
  was a rate limit (review of #1294). The API engine's `errorOf` uses the same pattern plus "maximum context length",
  "prompt / input is too long" and "exceeds the context", for a 400 / 413 or an error inside the stream; a bare "too
  long" (a tool name) or "maximum … tokens" (max_tokens over the cap) is a provider error. A per-minute token limit is a rate
  limit, never a full conversation, though it says "too many tokens" or "request too large" (text with "per min",
  "TPM", "per minute" or "rate limit": OpenAI's "Request too large for gpt-4o … on tokens per min"), so it never
  starts a useless fresh session.
- **Rule, Claude Code:** Claude Code still compacts its own session first. When it ends with that error anyway (its
  compaction could not make room, or one result was too big), the turn starts a fresh session in the same answer: the
  chat's history window in the instructions with the summary of the older part (#1283: before the first fresh start
  the turn makes or extends it, waited for at most 30 s with its step, as before any fresh session; a resumed session
  had none made), then `<answer_so_far>` in front of the person's message (`chat/context-recover.ts`). That block
  says the answer goes on, gives the end of what the answer already wrote (at most 12,000 characters) and the labels of
  its finished steps (at most 40; sub-agent steps and thinking left out), as data, and tells the AI not to repeat text
  or redo steps, to read files again when it needs their content and to work in smaller parts. The text already on
  screen stays; a step "The conversation got long, so the AI made room and is continuing" (6 languages) says so. At most
  2 fresh starts per answer (`CONTEXT_RECOVER_MAX`); each takes the rounds used from the answer's round limit, and
  with fewer than 2 rounds left the answer pauses at the round limit instead (its session dropped). The block is built
  at each launch of a fresh session after a recovery, so a later fresh start in the same answer (another AI account, a
  refusal or crash retry) gets what was written and done by then, never an older note that would redo a step. In a
  shared chat a step's label in the block is the one with its file targets for the person whose answer it is (the
  viewers' copy shows the verb only).
- **Rule, reads (#1285):** the files the answer read before the fresh start are not text the new session has. Those
  reads stay good for edits (and the in-place tools), but a whole-file replace (write, make_file) asks for a new read
  first, the same as for an earlier answer's read in a fresh session (`TurnFiles.answerTextGone`: this answer's reads
  become edit-only until read again, and they are kept for the next answer without a session). Codex the same.
- **Rule, Codex:** Codex starts fresh every turn; a context error is tried once more with the same block in front of
  the message (built at each launch after that, as for Claude Code).
- **Rule, API engine:** like Claude Code's compaction, in place: the results of the oldest tool round still holding
  some are replaced by a short note ("taken out to make room … call the tool again"), and the round is tried again; with
  only the newest round left, its long results are cut to their first 2,000 characters. At most 3 times per answer
  (`CONTEXT_SHRINK_MAX`); the system prompt, the message and what the model wrote are never cut. A retried round does
  not count against the round limit.
- **Rule, when it still does not fit:** the answer ends with the context error, now "This answer needed more than the
  AI can keep in mind at once. Send "continue" to go on, or ask for a smaller part." (6 languages; the old texts stay
  recognised for stored errors). That chat's saved session is dropped, so the next message starts fresh from the
  history (with the partial answer in it) instead of resuming a session that cannot fit. The memory note under an
  answer no longer suggests a new chat ("If something important from earlier is missing, say it again.").
- **Kept:** guests, shared chats and confidential chats get the same recovery: the fresh session is built the same way
  as any fresh session of that chat (the transcript this person may see, their own steps and text only). The block is
  data (`answer_so_far` and `answer_text` joined the neutralized tags), so text in it cannot close it.
- **Measured:** see the PR (real AI on a copy of the QA team).
- **Left out:** counting tokens ourselves before a call; turning off Claude Code's own compaction.
- **Tests:** `tests/unit/b-context-recover.test.ts` (the matcher, the texts, the step label, the block, Claude Code
  through the real launcher with the fake engine: goes on without an error, still too long after two starts ends with
  the error and the next message starts fresh; Codex; the API engine making room).
- **Version impact:** patch, no migration.
