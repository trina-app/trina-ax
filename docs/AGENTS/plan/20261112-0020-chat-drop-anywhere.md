# AI chat: a file dropped anywhere on the chat attaches it (TC-071)

- Date (UTC): 2026-11-12 00:20
- Branch: `fix/chat-drop-anywhere`
- Status: done
- Where: web/test/e2e. Why: the behaviour is already in the web core (pages/Chat.tsx, components/FileDropZone.tsx); it only lacked an end-to-end test.
- Version impact: none, tests only.

## Goal

QA TC-071: dragging a file over an AI chat's message list, away from the message box, should show that the whole chat
takes it, and dropping it should put the file on the box as a chip that Send takes into the chat.

## Finding

`dev` already does this: #309 (rooms drop-anywhere, 2026-11-10) wrapped the AI chat page in `FileDropZone` too (the same
component as the ✦ side chat's panel), and the box registers itself with `useDropTarget`. A browser drag (dispatched
events and Chromium's own drag through CDP) over the message list on `dev` shows the overlay and attaches the file. The QA
run most likely saw a build from before #309. The only test of it was a unit test (`web/test/unit/file-drop.test.tsx`).

## Scope

In: `web/test/e2e/chat-drop.spec.ts` at 1440: overlay over the chat column from the message list, leaving / Esc clear it,
drop on the list gives a chip and Send takes it, drop on the box still works once, text and a page-dragged picture are
left alone, and one real browser drag (CDP `Input.dispatchDragEvent`).
Out: product code (none needed). Home and a project's new-chat box have no message list and still take drops on the box
only; rooms (TC-064) unchanged.

## Risks

None for users. The CDP drag is Chromium-only; the spec runs in the chromium project only.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `build:web`, `test:web`, e2e chat*, composer*,
side-chat*, attach*, room-drop. Checked that 3 of the 5 tests fail with the chat page's `FileDropZone` replaced by a
plain `div` (the box-only behaviour of the QA report).

## Result

Tests only; see the PR.
