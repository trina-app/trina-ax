# Every message's actions come from one place

- Date: 2026-11-26
- Status: accepted
- Supersedes: the "one quiet text button" look in [Trina side chat: send here](../DECISIONS.md) (its words stay, the
  icon is the shared one); the "tap to show" rule for the AI chat's phone actions (`components/chat/Messages.tsx`); in
  [The room file viewer](../DECISIONS.md), the "Where" list for a file chip under an answer sent from an AI chat
- Branch: feat/shared-message-actions (the owner, UX audit package B: "컴포넌트화, 공통관리")
- Plan: [20261126-1025-shared-message-actions](../AGENTS/plan/20261126-1025-shared-message-actions.md)

- **Ask:** the same message action looked and opened differently from surface to surface. On a phone the AI chat showed
  icons on a tap, the side chat and rooms opened a sheet on a long press (rooms with emoji). On a computer there were
  two "reply in thread" icons, "send to a conversation" was an icon in the chat and a text button in the side chat, and
  the answer on top of a shared chat's thread had no copy, menu or steps. Copy said ✓, "복사됨" or "복사했어요". A
  document an AI made opened in the right panel in the chat but full-window once it was sent to a room. Make them
  shared components, managed in one place.
- **Rule: one module draws every message's actions** (`web/src/components/messages/MessageActions.tsx`). A surface
  lists what a message allows (`MessageAction[]`: copy, copy link, select text, edit, thread, Ask Trina, send to a
  conversation, regenerate, suggest a skill, remove a preview, delete); the module draws them with one icon per action
  (`ACTION_ICON`) and one set of words:
  - **Touch screens (any width): a long press opens one sheet** (`useMessagePress`, `MessageActionSheet`) on the AI
    chat (questions and answers), a room's side chat, a room's timeline and thread, and a shared chat's thread (its
    answer and its replies). A room's sheet has its reactions on top; reactions stay only where rooms have them. A tap
    shows nothing. Each surface keeps its skip list: the AI chat skips links, buttons, text boxes and cards; a room
    skips only parts with their own menu (a link in a room message still opens the message's sheet). No sheet for a
    message with nothing to act on (being sent, edited, streamed, hidden, deleted; an event line). The model that
    answered is the sheet's title on every AI answer.
  - **Phones:** the row under a message is hidden from sight only (screen readers and keyboards reach it); the newest
    answer in the AI chat keeps its row; a room's side chat keeps every answer's icons in the sheet and its send button
    in sight (CHATS-17, unchanged); the branch switch always shows.
  - **Select text** (sheet only, AI chat and a shared chat's thread answer): the long press steps aside on that message
    so the phone's own selection works, until a touch outside it.
  - **Computers:** `MessageActions` with `layout="float"` (the hover bar of rooms and threads, now also on a shared
    chat thread's answer: quick reactions where the room has them, thread and Ask Trina as icons, the rest under ⋮) or
    `layout="row"` (the AI chat's icon row). "Reply in thread" is `MessageSquareText` everywhere.
  - **Send to a conversation:** one icon (`MessageSquareShare`) in the chat's row and sheet and on the side chat's
    button. The side chat keeps its words next to the icon: it sends in one click, so where it goes must be readable
    on a phone too.
  - **Copy:** a button that stays in sight turns into ✓ and says "복사했어요"; from a sheet or ⋮ menu the same words come
    as a toast, only when the copy worked (`messages.copied`, six languages; `rooms.copied` removed). A link copy says
    "링크를 복사했어요". The copy buttons inside an answer's code blocks, tables and quotes are content controls and keep
    theirs.
- **Rule: a file an AI made opens one way** (`web/src/lib/messageFiles.ts` `openMessageFile`): a picture in the image
  viewer, any other file in the right panel, in the chat and in a room alike. A room's file chip under a message an AI
  made (a shared answer, `RoomMessage.sharedAnswer`, or an old room-AI answer) opens the panel and is not in the
  viewer's ← → list; it gives up the viewer's who/when/where bar and its thread / Trina column for that file. A file a
  person uploaded keeps the room's full-window viewer.
- **Kept:** no "send to Trina" in threads ([20261118-thread-no-send-to-trina](20261118-thread-no-send-to-trina.md));
  thread replies of a shared chat have copy and delete only; the side chat's one-click send, ▾, sent line and confirm
  step; `MenuButton` itself (package C's).
- **Guard:** `web/test/unit/message-actions-guard.test.ts` fails when a message surface builds its own long press,
  hidden menu, copy button, copy words or action icon, or when anything imports a second thread icon or the removed
  `MessageHoverBar`. A new surface that draws messages is added to its list.
- **Tests:** `web/test/unit/message-actions-shared.test.tsx`, `message-actions-guard.test.ts`, the updated
  `message-actions-phone`, `phone-polish-2`, `chat-threads` unit tests; `web/test/e2e/message-actions.spec.ts` (390
  touch, 820 touch tablet, 1440).
- **Version impact:** minor (phone gesture and where an AI-made document opens change; no API or data change).
