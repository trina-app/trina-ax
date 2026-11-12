# Connect from the chat card: the same answer goes on with the new tools

- Date (UTC): 2026-11-12 00:38
- Branch: `feat/connect-then-continue`
- Status: done
- Where: server chat runtime (`server/src/chat/turn.ts`, `connect-service.ts`, `tools.ts`), API engine loop
  (`server/src/engine/api-agent.ts`), fake engine (`tests/lib/b-fake-engine.ts`). Why: owner decision 2026-11-12 on
  QA TC-128 changes the rule "the new connection's tools come with the next message" (docs/DECISIONS.md, "Connecting a
  service from a chat").
- Version impact: minor, a new user-visible behaviour (the answer goes on after a connect) with no API change.

## Goal

A member asks "summarize my Notion page about the launch" with Notion not connected. The AI shows the connect card,
the member signs in or pastes a key, and the AI goes on with the SAME answer, using Notion, without the person sending
the question again.

## How it works today

- `connect_service` already parks the turn on the card through `waitForPerson`, like `ask_user` (no slot held while it
  waits, #442). Only the turn's own person can finish the card (`POST /api/turns/:id/connect` checks the owner).
- After "connected" the AI is told "its tools are offered from the user's next message": a turn's tools are fixed when
  the engine starts (Claude `--allowedTools`, Codex `enabled_tools`, the model proxy token's team list, the lockdown
  check). Google Drive's tools are always offered, so a Drive connect already works in the same answer.

## Design (smallest safe mechanism)

The engine cannot take new tools while it runs, so the answer goes on in a **continuation attempt** of the same turn:

1. `connect_service` ends `connected` for a service (not Drive): the turn notes it (`TurnExec.noteConnected`). The
   result tells the AI what happens next, per engine:
   - Claude: "end this step now without more words; this same answer goes on right away with the new tools";
   - API engine: "its tools are yours from your next step";
   - Codex (no session resume) and anything else: unchanged, "from the person's next message".
2. Claude: when the attempt ends normally (no error, no stop, no budget, no limit) and a connection was made, the turn
   builds its tool set again (`buildToolSet`, same person, same chat kind: the same filters, so a room keeps only the
   asker's own Google apps, a confidential or shared chat none), and only when it has a tool it did not have, resumes
   the same engine session (the stash the attempt just wrote) with a short server note as the message: the connection
   is ready, its tools, go on with the person's request in this answer. New proxy token, lockdown and sub-agent list
   come from the new tool set. The text goes on in the same answer message (a paragraph break between).
3. API engine: the same rebuild between rounds (`beforeRound`), and the loop lists the tools again.
4. Limits: at most 2 continuations per answer; each continuation gets only the tool rounds the answer has left
   (`answerStepLimit`); the budget, the wall time and Stop are checked by `launch()` as for any attempt. A card skipped,
   timed out or stopped makes no continuation: the turn ends as before.

Who: the continuation runs as the turn's person (`spec.userId`); the card can only be finished by that person; the
rebuilt set is that person's connections only. Nothing changes for an answer without a connect.

## Scope

In: Claude engine and API engine; the AI's words in `connect_service` and its description; tests; docs.
Out: Codex (its runs start fresh without the answer so far; keeps "next message"); scheduled runs (no card anyway).

## Steps

1. Plan (this file).
2. `TurnExec.noteConnected()` + `connectContinues` mode; `connect-service.ts` result words; tool description.
3. `turn.ts`: tool set / extra tools / turn tools as mutable; continuation in the Claude attempt loop; API engine hook.
4. `api-agent.ts`: re-list tools when the turn says its tool set changed.
5. Fake engine: `{"afterContinue": [...]}` directives run on a resumed run that carries none.
6. Tests: connect → same turn continues and calls the new tool; skip; timeout; another person cannot finish it; no
   continuation without a connect; the round limit; API engine. Web: the card flow in the mock (e2e).
7. Docs: INTEGRATIONS.md "Connecting from a chat", changes/connect-then-continue.md; the DECISIONS.md change goes in
   the PR body ("Decision (for DECISIONS.md)").

## Risks

- A continuation resumes a session: if the stash is missing, no continuation (the answer ends as before).
- The AI may keep writing after "connected" instead of ending the step; the continuation still follows and says to go
  on with the request.
- No migration. No change to the card or its endpoint. Five languages: only server-to-AI text changes.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `build:web`, `test:web`; unit tests: connect-service, the new
connect-continue test, chat, integrations, turn-waiting-slots.

## Result

Built as planned (Claude continuation through a resumed session, API engine re-lists its tools, Codex unchanged).
Differences after review: the answer goes on also when no tool name is new (find_tools / call_tool, api_request); a
third card is told "next message"; too few rounds, no session or a failed rebuild pause the answer at the round limit
instead of ending silently; the continuation message is the turn context plus the note; a fresh-session retry after a
connect gets the new tools. PR: feat/connect-then-continue into dev.
