# Closing a chat thread must not scroll the chat back to its answer

- Date (UTC): 2026-11-20 21:30
- Branch: `fix/chat-thread-close-no-jump`
- Status: in progress
- Where: web/ (pages/Chat.tsx, lib/linkedAnswer.ts). Why: pre-release QA on a private QA copy of dev (QA sheet, new row for this finding).
- Version impact: patch (a web-only fix for a scroll jump)

## Goal

Found in pre-release QA of #119/#156 (check 5, "open a thread and close it again: the view must not jump back"). In a
chat (a shared session or a project chat) a thread opened from a link or an Activity row lights its answer. When the
reader then scrolls the chat elsewhere and closes the thread, the chat jumps back to that answer (1440 px; reproduced on
an origin/dev build: scrollTop 0 -> 552). Cause: closing puts the keyboard focus back on the answer's thread line
(QA TC-3888, Chat.tsx), and `focus()` scrolls it into view. Rooms already stay put.

## Scope

In: the focus return keeps the focus but does not scroll (`focus({ preventScroll: true })`).
Out: a phone still shows the answer when its thread closes (the thread was over the chat: lightAnswer, unchanged).

## Steps

1. Add `focusInPlace` to lib/linkedAnswer.ts and use it for the focus return in Chat.tsx.
2. Unit test: it passes `preventScroll: true`. E2E: scroll the chat away with a link-opened thread, close it, the chat stays.

## Decisions

Focus return stays (TC-3888); only the scroll goes. No change to the notice rules in docs/decisions/20261120-notif-open-parent-message.md.

## Result

(filled when done)
