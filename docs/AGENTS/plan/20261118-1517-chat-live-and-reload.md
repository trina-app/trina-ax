# Shared chats stream to everyone in them; a reloaded chat opens at the bottom; the side chat comes back

- Date (UTC): 2026-11-18 15:17
- Branch: `fix/chat-live-and-reload`
- Status: done
- Where: Team AX core: `server/src/chat/turn.ts`, `server/src/chat/store.ts`, `server/src/chat/runtime.ts` (live text
  of shared chats), `web/src/lib/stickToBottom.ts` and `web/src/pages/Chat.tsx` (reload), `web/src/pages/Room.tsx` and
  `web/src/components/rooms/SideChatPanel.tsx` (side chat). Why: chats, permissions and the room side chat are core.
- Version impact: minor (people in a shared chat see the answer as it is written; two reload fixes)

## Goal

QA found three chat bugs:

- TC-4961: in a shared chat (a team project's, or one shared with people) member B sees only "Thinking…" while member
  A's question is answered; the text appears at the end. B should see the answer as it is written.
- TC-4962: a reloaded chat opens above the bottom, so the newest answer and the messages waiting to be sent are below
  the fold, and it does not stay at the bottom while pictures and code blocks above load.
- TC-4963: the ✦ side chat beside a room stays closed after a reload even when a message waits in its queue, and a
  panel that was open before the reload is closed after it.

## Scope

In: live text and steps of a running answer for everyone who sees a shared chat now, through the same per-viewer
checks as the finished answer (who sees the chat, an answer hidden from them, step lines with paths, step details);
the REST read of a running answer the same; cards, queue positions, busy notices and usage stay the asker's. The chat
page opening at the bottom after a reload and staying there. The side chat reopening on a computer when it has queued
messages, and after a reload when it was open.

Out: live artifact previews for the others (they see the artifact when it is saved, as today).

## Steps

1. Server: `TurnExec` keeps the live viewers of a shared chat's answer (its audience now, without the asker, without
   anyone the answer is hidden from: `withheldFrom`), worked out again after a short time, after the answer's read
   record changes and when someone stops seeing the chat (`stopUserTurnsIn`). Deltas (also resets) go to them as they
   are; each step goes through `ChatStore.viewSteps` for that viewer; `message.done` goes to every person who sees
   the chat, built by `messageFor` for them.
2. `ChatStore.toMessage`: a running answer shows its live text and steps to a viewer it is not hidden from (it showed
   nothing before).
3. Web: the chat page keeps reading the messages again when someone else's turn starts (that brings the question and
   the answer's text so far) and ends (a missed event); the live events fill in between.
4. Web: find and fix why a reloaded chat opens above the bottom; keep following while content above grows.
5. Web: remember per tab (sessionStorage) which rooms had the side chat open; on the room page, reopen it after a
   reload when it was open, and on a computer when its newest side chat has queued messages.
6. Tests: server unit (live text to B, nothing of cards, step details or a hidden answer, a removed person gets nothing
   more), security test, web unit tests for the scroll and the side chat, the nearby e2e spec.

## Decisions

`docs/decisions/20261118-shared-chat-live-answers.md` (supersedes "a running answer's live text … stay with the runner"
and "Live answers for viewers" in "Not in phase 1" of docs/DECISIONS.md "Shared project chats").

## Risks

Permissions: the live events must not show what the finished answer would not (security test). Load: per-viewer work on
every delta is kept small by caching the viewer list. No migration. Five languages: no new strings expected.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, server unit tests of shared chats under Bun 1.3.12,
web unit tests, `web/test/e2e/shared-project-chats.spec.ts`.

## Result

- TC-4961: `server/src/chat/live-answer.ts` (new): the live viewers of a shared chat's answer and what each gets;
  `TurnExec` sends text, resets and steps to them, `message.done` goes to everyone who sees the chat (also for a queued
  turn that failed or was stopped); `ChatStore.toMessage` shows a running answer's text and steps to a viewer it is not
  hidden from. The test mock sends the same, and its "hold" answer writes its first half before it waits.
- TC-4962: the cause was the browser's scroll anchoring: after the jump to the bottom, the running answer and the
  waiting messages took their place under it and Chromium moved the list up 160 px; that scroll event read as the
  reader scrolling up. `anchorWhileFollowing` turns anchoring off while a list follows its newest message (every list
  using `useStickToBottom`).
- TC-4963: `lib/sideChatOpenKeep.ts` (sessionStorage per tab and person) and `sideChatComesBack` on the room page. On a
  phone only "was open" brings it back (decision file).
- PR: see the pull request of branch `fix/chat-live-and-reload`.
