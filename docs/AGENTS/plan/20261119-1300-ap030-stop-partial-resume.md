# The message after Stop: the resumed session knows the partial answer (QA AP-030)

- Date (UTC): 2026-11-19 13:00
- Branch: `fix/ap030-stop-partial-resume`
- Status: done
- Where: `server/src/chat/turn.ts` (claudeMessage), `server/src/chat/prompt.ts` (stoppedAnswerBlock),
  `tests/lib/b-fake-engine.ts` (`sessionNow`), `tests/unit/b-chat.test.ts`
- Version impact: patch. No API, setting or migration change.

## Problem

QA "AI parity 2026-11-19", AP-030 (Bug, High): the person presses Stop mid-answer, then sends a new message in the
same chat. The AI says "my last reply was blank". The partial text is in the database (it shows after a reload), and a
regenerate (a fresh session, built from the database history) sees it.

## Cause

Stop kills the engine. Claude Code writes the person's message into its session file at once, but an answer only when
its message ends: the text that was streaming when Stop came is not in the file. The launcher still returns the file,
`stashSession` keeps it, and `engine_session_leaf_id` becomes the stopped answer. The next message resumes that
session, which ends with the person's message and no answer.

## Fix

The message after an answer that ended `stopped` (or `error`) with text, in a resumed Claude session, starts with a
`<stopped_answer>` note: why the answer did not finish, and its text (the last 12,000 characters, tags neutralized) as
data. Like `<continuation>`, only the next message has it. A fresh session has the text in its history already, so it
gets no note. An answer hidden from this person in a shared chat gets no note.

## Steps

1. Note and its place in the resumed message. Done.
2. The fake engine writes its session early (`sessionNow`), as Claude Code does, so a stopped run keeps a session.
   Done.
3. Test: stop, then the next message resumes with the note and the partial text; the message after it has none. It
   fails without the fix. Done.
