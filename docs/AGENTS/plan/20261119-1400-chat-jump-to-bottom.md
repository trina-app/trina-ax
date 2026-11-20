# AI chat: a jump-to-bottom button when the reader scrolled up (QA AP-043)

- Date (UTC): 2026-11-19 14:00
- Branch: `fix/chat-jump-to-bottom`
- Status: done
- Where: `web/src/pages/Chat.tsx`, `web/src/lib/stickToBottom.ts` (farFromBottom, toBottom), i18n `chat.toBottom`
  (6 locales), `web/test/unit/stick-to-bottom.test.ts`, `web/test/e2e/chat-jump-to-bottom.spec.ts`
- Version impact: patch (a small UI addition, no API change).

## Problem

QA "AI parity 2026-11-19", AP-043 (UX, Low): while an answer streams the reader can scroll up and the view stays, but
there is no button back to the bottom. claude.ai shows a round down-arrow button above the message box.

## Fix

- `farFromBottom`: more than JUMP_BUTTON_PX (300 px) from the end. The list's scroll event sets `away` from it.
- A round IconButton (ArrowDown, tooltip "Jump to the latest") above the message box while `away`. A click goes to the
  bottom and the list follows again (`useStickToBottom().toBottom`: stick on, jumpToBottom).
- `away` goes back to false when the chat changes.

## Steps

1. Helper, hook method, button, words in 6 languages. Done.
2. Unit test of farFromBottom; e2e: a long answer, scroll to the top, the button shows, a click goes to the bottom and
   hides it. Done.
