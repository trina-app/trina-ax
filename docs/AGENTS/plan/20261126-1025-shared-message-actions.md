# One way to act on a message: shared action sheet, action bar, copy and document opener

- Date (UTC): 2026-11-26 10:25
- Branch: `feat/shared-message-actions`
- Status: draft
- Where: trina-ax `web/src/components/messages/` (new, the one place), callers in `web/src/components/chat/` and
  `web/src/components/rooms/`. Why: the AI chat, a room's side chat, rooms and threads each built their own message
  actions; the owner asked for shared components managed in one place ("컴포넌트화, 공통관리"), UX audit package B.
- Version impact: minor. Phones open an AI chat message's actions by a long press instead of a tap, and an AI-made
  document sent to a room opens in the right panel: user-visible behaviour changes, no API or data change.

## Goal

The same message action looks and opens the same way on every surface:

1. **Phone (touch):** a long press on any message opens one shared sheet. Today the AI chat shows icons on a tap
   (`Messages.tsx` `tapped`), the side chat opens a sheet (`PressSheet`), rooms open a sheet with emoji
   (`RoomMessages.tsx` inline `MenuButton`), a shared chat's thread its own (`ChatThreadPanel.tsx`).
2. **Computer:** one `MessageActions` component with one icon per action. Today there are two "reply in thread" icons
   (`MessageSquareReply` in the chat, `MessageSquareText` in rooms), "send to a conversation" is an icon in the chat and
   a text button in the side chat, and the first answer in a shared chat's thread has no copy, no menu and no steps.
3. **Copy:** one behaviour. Today: a ✓ icon (`CopyButton`), a toast "복사됨" (`common.copied`, side chat sheet), a toast
   "복사했어요" (`rooms.copied`, rooms and threads).
4. **AI-made documents:** open in the right panel wherever they show. Today a document opens in the side panel in the
   chat but in the full-window viewer once it was sent to a room (the room file chip).

## Scope

In:

- `web/src/components/messages/messageActions.tsx` — the registry: `ActionId` (`copy`, `copyLink`, `edit`, `thread`,
  `askTrina`, `sendToChat`, `regenerate`, `suggestSkill`, `removePreview`, `delete`), one icon each (`ACTION_ICON`),
  `MessageAction` (id, label, run, disabled, danger, testId), `toMenuItems()` for sheets and ⋮ menus (danger last on a
  phone, as `MenuButton` already sorts).
- `useMessagePress(on)` — the one long-press binding (touch only, any width; a finger held on a control, a text box,
  a card or a `[data-own-menu]` is no long press; the phone's own text menu kept away). Replaces `usePhonePress`, the
  rooms' `useLongPress` wiring and the thread reply's.
- `MessageActionSheet` — the one sheet (a hidden `MenuButton` opened by the press signal; optional title, optional
  header for the rooms' reaction strip). Replaces `PressSheet`, the rooms' inline `MenuButton`, the thread reply's.
- `MessageActions` — the computer's actions, two layouts of one component and one icon set:
  `layout="float"` (Slack-like hover bar of rooms, threads and the thread's answer: quick reactions where the room has
  them, then `thread`/`askTrina` icons, then ⋮ with the rest; what `MessageHoverBar` does today, moved here) and
  `layout="row"` (the row under an AI chat message, Claude-like: each action an icon button with a tooltip). Both draw
  an action's icon from `ACTION_ICON`. `MessageHoverBar.tsx` goes; its quick-reaction constant moves with it.
- `useMessageCopy()` / `CopyAction` — one copy behaviour: a button that stays on screen turns into ✓ with the label
  "복사했어요" for 1.5 s; from a sheet or a ⋮ menu (the menu is gone) the same words as a toast. One key
  `messages.copied` in six languages (the old `rooms.copied` text); `rooms.copied` is removed. Rich copy (HTML) of an
  AI answer is kept. Link copy keeps its own words ("링크를 복사했어요").
- `openMessageFile()` in `web/src/lib/messageFiles.ts` — the one opener for a file an AI made: a picture in the image
  viewer, any other file in the right panel (`openFilePreview`). Used by the chat's attachment tiles and, new, by a room
  file chip under a message an AI made (a shared answer, `RoomMessage.sharedAnswer`, or an old room-AI answer,
  `authorKind === 'ai'`). People's own uploads in rooms keep the full-window viewer (recorded decision "The room file
  viewer"). The chip still registers in the viewer's ← → list so stepping from a photo still reaches it.
- Surfaces moved onto these: AI chat (`UserMessage`, `AssistantMessage`), side chat (same components), room timeline
  and room thread (`RoomMessages.tsx` `MessageRow`), shared chat thread (`ChatThreadPanel.tsx` `ReplyRow`, and
  `ThreadAnswer`, which gains copy on the float bar and in the long-press sheet, plus the answer's step list as the
  chat shows it, folded).
- Phone rule after this, one for every surface: actions live in the long-press sheet. The newest AI answer in an AI
  chat or side chat keeps its row in sight (as today in the AI chat); every other message's row is hidden from sight
  only (sr-only: screen readers and keyboards still reach it). A tap no longer reveals icons. The branch switch
  ("‹ 1/2 ›") stays in sight. The side chat's send button keeps its place under every finished answer.
- "Send to a conversation": the chat's `ShareToRoom` and the side chat's `SendHere` both show as the same icon button
  (`MessageSquareShare`, tooltip and name = its words: "대화방에 보내기" / "스레드에 보내기"); the side chat keeps its ▾
  for the room and its "✓ 보냈어요 · 보기" line. In the sheet it is one labelled row.
- Guard test `web/test/unit/message-actions-guard.test.ts`: message surfaces (`components/chat/Messages.tsx`,
  `ChatThreadPanel.tsx`, `components/rooms/RoomMessages.tsx`, `SideChatPanel.tsx`, `ThreadPanel.tsx`, and any new file
  that renders `data-testid="...message..."` rows under `components/chat|rooms`) may not import `useLongPress`, may not
  pass `openSignal` to `MenuButton`, may not import `MessageSquareReply`, may not toast copy words of their own
  (`common.copied`, `rooms.copied`), and room file chips go through `openMessageFile`. Unit tests for the registry,
  the sheet and copy.
- e2e `web/test/e2e/message-actions.spec.ts` at 1440×900 and 390×844 (touch, `hasTouch`): long press opens the same
  sheet on an AI chat answer, my question, a side chat answer, a room message, a room thread reply and a shared chat
  thread reply; the desktop bar has the same thread icon in the chat and the room; copy says "복사했어요" from the
  sheet and ✓ on the row; an AI document sent to a room opens in the right panel. Existing e2e and unit tests that
  encode "tap to show" are updated.

Out:

- Package A (composer) and package C (menus, delete/leave flows, wording): `MenuButton.tsx` internals, `RoomMenu.tsx`,
  delete confirm texts are not touched. The words of existing actions stay as they are.
- Room file chips of people's own uploads, the Files page and the image viewer itself.
- Reactions stay only where rooms have them (no reactions in AI chats or in a shared chat's thread).
- No "send to Trina" in threads (docs/decisions/20261118-thread-no-send-to-trina.md) — nothing added there.
- 👎 problem reports (#633, not merged yet): when it lands first, its action joins the registry as `report`; if this
  lands first, #633 rebases onto it.

## Steps

1. Plan (this file), reviewed by one independent reviewer.
2. `components/messages/` registry, press, sheet, actions, copy; `lib/messageFiles.ts`.
3. Move AI chat + side chat (`Messages.tsx`), rooms (`RoomMessages.tsx`), shared thread (`ChatThreadPanel.tsx`),
   `SendHere` / `ShareToRoom` button look; delete `MessageHoverBar.tsx`, `PressSheet`, `usePhonePress`.
4. i18n: `messages.copied` in six languages, drop `rooms.copied`.
5. Guard test, unit tests, e2e at 1440 and 390; update old tests.
6. Decision file `docs/decisions/20261126-shared-message-actions.md`, `changes/shared-message-actions.md`.
7. `bun run typecheck`, `bun run check:prepush`, `cd web && bun test test/unit`, related e2e. PR into dev, not queued.

## Decisions

New: `docs/decisions/20261126-shared-message-actions.md` "Every message's actions come from one place". Amends:

- [Trina side chat: send here](../../DECISIONS.md) — "one quiet text button": now the shared icon button with the same
  words as its name and tooltip; the one click, ▾, sent line and confirm step are unchanged.
- [The room file viewer](../../DECISIONS.md) — the "Where" list: a file chip under an AI-made message (a shared answer)
  opens in the right panel like the chat's; people's own files keep the viewer.
- The AI chat's phone "tap to show" (Messages.tsx header comment, `message-actions-phone` tests) — replaced by the long
  press; the newest answer keeps its row.
- Kept: [20261118-thread-no-send-to-trina](../../decisions/20261118-thread-no-send-to-trina.md); reactions only in
  rooms; [20261116-chat-answer-threads](../../decisions/20261116-chat-answer-threads.md) (thread replies have copy and
  delete only).

## Risks

- Many e2e and unit tests hold the old test ids and the tap rule; test ids are kept where the element stays
  (`message-more`, `message-copy`, `side-answer-copy`, `reply-in-thread`, `share-to-room`, `send-here-*`) so only the
  tap tests change.
- Long press on tablets (touch ≥ 768 px) in the AI chat: today nothing; after, the same menu. Its icons stay in sight
  there.
- Open PRs touching the same files: #633/#634 (`Messages.tsx`, 👎). Rebase before the PR; add `report` to the registry.
- No server, migration, permission or API change. Six languages for one new key.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run check:docs`, `cd web && bun test
test/unit`, `bun run build` then e2e: `message-actions`, `room-hover-bar`, `room-copy`, `chat-threads`,
`side-chat-send`, `answer-to-room`, `chat-look`, `phone-polish-2`, `answer-actions-spacing`, `thread-plus-trina`,
`room-reaction-picker`, `phone-targets`.

## Result

(at the end)
