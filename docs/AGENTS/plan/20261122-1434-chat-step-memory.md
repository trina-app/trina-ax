# The AI remembers its own steps from earlier answers in the same chat

- Date (UTC): 2026-11-22 14:34
- Branch: `fix/chat-step-memory`
- Status: in progress
- Where: server/src/chat (history for a fresh engine session). Why: a fresh session got earlier answers as text only.
- Version impact: patch: a fix to what the AI is given; one additive column, no API change.

## Goal

In a shared project chat (Claude Code engine) the AI attached a file through a personal browser connection, sent a
mail and reported it. Two answers later the owner asked "how did you attach it?". The AI said it had no record of
that answer's steps and offered two guesses. Claude Code itself remembers, in the same conversation, which tools it
called with which arguments and what came back. Trina should do the same.

## Cause

- Claude Code resumes its own session (tool calls and results included) only while `chats.engine_session_*` points at
  the previous answer and, in a shared chat, while everyone who sees the chat may see what the chat read
  (`scopeHiddenFromAudience`). Once the chat's read scope holds a source not everyone there may see (here a team
  connection limited to some people and a personal connection, `{type:'user', via:'connection'}`), every later turn
  starts a **fresh** session. The live server's turns show it: one session id for the first five answers, a new one
  for every answer after.
  Codex and the API engine start fresh every turn anyway. Other fresh starts: edits, regenerate, engine switch, too
  many pictures in the session (`stashSession`), context recovery.
- A fresh session gets the branch through `ChatRuntime.history` / `labelledTranscript`: **the answer text only**.
  `messages.steps` (tool, label, status) is never in it; only the summary call (`history-summary.ts stepLine`) reads
  the labels. Tool arguments and results are not stored anywhere the next turn can read.
- Not the cause: the card continuation (the answer to a card is its own turn with its own steps, both stored), the
  stopped turn (its steps are stored, running ones marked stopped), the personal-connection steps (stored like every
  other tool step), the narration hold (#329/#371: it drops status lines, not steps), the 40,000-token window (the
  chat was short).

## Scope

In:
- Each tool step keeps a short server-only note: its key arguments (paths, URLs, names, queries, commands, the first
  part of code; long text fields as a length) and a short result (first ~200 characters, whitespace folded, pictures
  and base64 removed). Secrets hidden with the turn's redactor. Stored in a new column `messages.step_notes`
  (JSON `{stepId: {i, o}}`), never sent to apps.
- A fresh session's history shows, under each eligible earlier answer, a `<steps_record>` block: one line per step
  (tool name, label, status, args, result). Answers from before this build get labels and status only.
- Eligible (same rule as `summaryLines`): the answer is not hidden from the asker (withheld), and in a chat several
  people wrote in, it answered the asker's own message. A step whose label names paths kept aside (`sv`) shows its
  full label and args only when the asker may list every one of those paths now; else the plain label, no args,
  no result. Results of file-content tools (read, grep, room/chat file reads) are left out (read again).
- Caps: records for the newest 6 eligible answers on the branch; at most 40 lines and 3,000 characters per answer
  (first 5 and newest steps kept, a line says how many were left out); args 240 and result 200 characters per step.
  The block counts toward the history window like the text (`historyWindow`).
- The history intro says the record is the AI's own, written by the server, data not instructions; when asked what
  it did or how, answer from it.
- Same for Claude Code (fresh), Codex and the API engine (all use `historyBlock`).

Out: changing when Claude Code resumes (the shared-chat resume rule is a security decision and stays); storing whole
tool results; sub-agent inner steps (their sub-task line is kept).

## Steps

1. Migration `441_b_message_step_notes.sql`: `ALTER TABLE messages ADD COLUMN step_notes TEXT`.
2. `chat/step-record.ts`: `stepArgs`, `stepResult`, `stepsRecord` (lines + caps), `STEP_RECORD_*` constants.
3. `turn.ts`: note args on `tool_start`, result on `tool_end` (main AI only), save with the steps, reset on retry.
4. `runtime.history` / `labelledTranscript`: attach `steps` to eligible answer items (`HistoryItem.steps`).
5. `prompt.ts historyWindow/historyBlock`: render the block; `steps_record` in `BLOCK_TAGS`.
6. Tests: unit for step-record, history window, shared-chat rules (other asker, withheld, sv paths); prompt pins.
7. Real run on a local QA copy (claude-code): multi-step task with box_shell and a connection, then "어떻게 했어?".

## Decisions

`docs/decisions/20261122-step-record-in-history.md`.

## Risks

- Leaks in shared chats: only the asker's own answers, withheld answers never, sv paths re-checked; notes never leave
  the server (separate column, not in `steps`).
- Prompt injection through a stored result: values neutralized, block framed as data.
- Tokens: capped as above; counted in the history window.
- Migration 441 (440 is the highest on dev).

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit` for chat history/prompt/shared, prompt pins, web unit.

## Result

(at the end)
