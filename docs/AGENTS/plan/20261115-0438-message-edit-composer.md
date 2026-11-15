# Editing a room message: in the bottom box on phones, no clipped lines anywhere

- Date (UTC): 2026-11-15 04:38
- Branch: `fix/message-edit-composer`
- Status: done
- Where: web/ (Team AX core). Why: room message editing is a core chat feature (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix of an existing feature's layout and where it opens on phones

## Goal

Owner (2026-11-15, iPhone app): editing my own message in a thread looked broken. The edit box sat inside the
message, its third line was cut off under Cancel / Save, and the normal reply box with "Also send to the room" stayed
below it. On phones the common pattern is to edit in the box at the bottom.

## Scope

In:
- Phone width (< 768 px): Edit moves the message into the room's or thread's box at the bottom. The message is marked
  in the list; the box says "Editing message", holds the whole text with its mentions (it grows, then scrolls), the
  caret at the end. Round ✕ (cancel) and ✓ (save) take the send button's place; the clip, mic, files, link question,
  "@everyone" question and "Also send to the room" step aside. ✓ is off while the text is empty or unchanged. ✕ / Esc
  cancel; the reply that was being written comes back. Return makes a new line on touch screens.
- Computers: the edit stays inside the message; the field grows with its text (no clipped line) and its buttons sit in
  their own row under it. A phone place with no box (a deleted peer's DM) edits inline the same way.
- AI chat: the user-message edit field grows with its text too (it stays inline: it sends a new branch, not an edit).

Out: moving the AI chat's edit into its composer (different action: a resend with a branch note and the key warning).

## Steps

1. store/roomEdit.ts: the message being edited by place, the places with a box on screen.
2. RoomMessages.tsx: phones send Edit to the box when the place has one; mark that message. EditForm: auto-grow,
   buttons in their own row.
3. RoomComposer.tsx: edit mode (hold the draft, restore it, save through store/rooms.ts edit, failed edit reopens).
4. lib/autoGrow.ts shared by the boxes; one new string in six languages.
5. Tests: unit (store, fitHeight), e2e room-edit.spec.ts at 390 and 1440.

## Risks

Draft handling (the held reply must never be overwritten or sent): covered by the e2e. No server, permission or
migration change.

## Result

Done: phone edits in the box, desktop inline field grows. Unit and e2e green; screenshots in the PR.
