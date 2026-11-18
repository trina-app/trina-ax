# Safety cards wait as long as it takes, then the call runs again with the answer

- Date (UTC): 2026-11-18 23:25
- Branch: `feat/safety-cards-wait` (stacked on `feat/questions-wait-and-todo-card`, PR #1343: it uses its table and answer flow)
- Status: done
- Where: Team AX core (server/src/chat, server/src/routes). Why: chat cards and the AI's tools are core.
- Version impact: minor (three columns, cards that wait)

## Goal

Follow-up of #1343 (QA TC-5005): Claude Code has no time limit on its permission prompts. Our safety cards (delete,
share, a website, a browser site) waited inside their tool call for the admin's time (10 minutes by default), then
closed, and the call went on as a no.

## Scope

In: the cards of delete_files, share_with_person, share_folder, stop_sharing, web_fetch, save_url and the browser tools,
raised by the main AI in a chat a person watches (shared chats too: only the asker answers).

- The card is kept in `open_questions` with the call that raised it (tool and arguments, keys already hidden; the
  window of a browser card). The call ends having done nothing (it raises its card before it changes anything) and the
  AI is told to end its answer. No time limit; after reloads and restarts.
- The answer (its buttons only) starts the next turn. Before the engine starts, that turn runs the saved call again
  once through the same handler as the engine's calls: the person as they are now, the confidential lock, every check
  and card of the tool. The same card takes the saved answer; a card that reads differently now is asked again.
  The AI gets the call's result with the message.
- Exactly once: the answer is claimed in one transaction (a second answer gets 409), the call runs before the engine's
  attempts (a retry does not run it again), and the rows go when the turn starts.

Out: connect_service. Its card is finished through /connect with a sealed key and a sign-in flow whose state (the
connection the card made, a running connect, OAuth) lives with the running turn; it keeps its own wait for now.
Slack questions and scheduled runs keep the wait inside the call, as for #1343.

## Steps

1. Migration 424: `open_questions.call_tool`, `call_args`, `window_id`.
2. chat/tools.ts: the main AI's call of a CARD_LATER tool is tracked; a deferred card makes the call answer
   `{"waiting_for_user": true}`.
3. chat/turn.ts: `cardLater` (keep the card with its call), `replayCalls` (run the calls again at the next turn's start),
   the saved answer given to the same card (`sameCard`).
4. routes/chats.ts: any card kind answered from the database, buttons only, window-only listing.
5. Tests: each card kind, a restart, access lost, a double answer, "no".

## Decisions

docs/decisions/20261119-safety-cards-wait.md.

## Risks

A tool that changed something before its card would do it twice: only tools that ask first are in the list. The
tests of each card's own logic run with the wait inside the call (harness default), as a Slack question's card does.

## Tests

`bun run check:prepush`; tests/unit/b-safety-cards-wait.test.ts, b-browser, b-open-questions, ai-delete-files,
b-share-with-person, b-share-folder, b-stop-sharing, web-allow-all, p0-webfetch-gate, site-allow.

## Result

Built as planned. connect_service is left out (see Scope). The harness runs the older card tests with the wait inside
the call (`safetyCardsWait: false`); the new tests run with it on.
