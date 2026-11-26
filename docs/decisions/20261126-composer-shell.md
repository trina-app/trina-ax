# One message box: every box is the composer shell

- Date: 2026-11-26
- Status: accepted
- Supersedes: the side chat's own box (20261117-side-chat-mic "Rule", the box parts only; the mic rules stand), the
  "touch screen Enter sends" behaviour of the side chat, and the "On a computer no team-folder files here" line of the
  side chat's file comment (archive "Files in the Trina side chat")
- Branch: feat/composer-shell (the owner, 2026-11-26: "컴포넌트화, 공통관리"; plan docs/AGENTS/plan/20261126-1026-composer-shell.md)

- **Ask:** the four message boxes (the AI chat's, the ✦ side chat's, a room's, an AI answer's thread) were four pieces of
  code that drifted: Stop in one box, Esc nowhere, a `+` menu in one box and a 📎 file dialog in two, a grey square
  send in one box and a round one in the others, three text heights and two fonts, Return sending on a phone in one
  box, the key warning in one box, drafts lost in two, a failed send only toasted in one. The owner wants one shared
  component, managed in one place.
- **Rule:** every message box is `web/src/components/composer/ComposerShell.tsx` with its parts (`ComposerField`,
  `AttachMenu`, `ComposerButtons` with `chat/StopButton`, `ComposerNotices`, `keys.ts`, `hint.ts`). A box passes what it
  allows. `web/test/unit/composer-single.test.ts` fails on a new text field outside its list, on the box's parts used
  outside the shell and the four boxes, and on an Enter handler that is not IME-safe.
- **The same in every box:**
  - Enter sends with a keyboard. Shift+Enter, a word an input method is composing (`isComposing`, keyCode 229) and a
    touch screen's Return make a new line (as decided for phones in "Home on phones"); the round button sends there.
  - One round accent send; the clock ("Send when ready") and the AI's-question Answer are the same button; Stop is the
    same round button. While my answer runs: Stop, and the clock beside it only when there is something to send.
  - **Esc stops** the running answer in a box that has Stop (the AI chat's, the side chat's; in a shared chat only the
    person whose turn it is has Stop). Order: the box's `/ # @` lists, then voice (Esc throws a recording away), then
    the stop. No stop while an input method composes, while any menu, list or dialog is open, or in a box inside a
    dialog (the file viewer's column, whose Esc is the viewer's). The stop takes the key, so a panel's Esc (the room
    page, a thread) does not also close the panel; the next Esc does. The box's focus only, not the whole page.
  - One text size (the reading size) and one height: at most `min(240px, 35dvh)` on a computer; on a phone the whole
    box within about 35 % of the screen (QA TC-252's formula for every box, replacing the AI chat's 30 %).
  - The `+` attach: a small menu on a computer (this computer, team files), the attach sheet on a phone. Team files
    now on a computer too in rooms (copied as an upload, with the "reaches N more people" line) and in the side chat
    (by reference). Answer threads take no files (a reply has none).
  - The mic in every box, the answer threads' too (the recording names the chat; the server takes a shared chat the
    person sees; guests and confidential chats as everywhere).
  - The empty box's line: the words on their way, the AI's question, "Sends after this answer", then the box's own.
  - Under the box on a computer the AI boxes' note `chat.footerAi` ("AI can make mistakes. Check important
    information."); the side chat's own "{name} is AI and can make mistakes" is gone, and on a phone it has no note
    (its header says "Only you").
  - "No usable AI" (`AiAccessBanner`) above every AI box, for everyone it concerns (the side chat showed it to guests
    only).
  - The limit, mic-blocked, send-failure and error notices under the box, one look. The side chat keeps a send that
    failed for the connection in its box with "Retry" (it sent a toast); while Trina updates it sends by itself.
  - The key or password warning on every send of every box whose text reaches the AI: the AI chat's and the side
    chat's (it checked answers only). Rooms and answer threads keep none: they are people's boxes, and a warning there
    would be a new rule for people's chats.
  - Drafts kept on this device: the side chat's now across reloads, with the chat it was written in: it comes back only
    into that chat, and after a reload the room's newest side chat with a kept draft opens again, as a box with text
    keeps its chat while the page is open; an answer thread's across closing and reloads,
    with its mentions.
- **Kept different (decided elsewhere):** the side chat's queue and two-row phone box (20261118-side-chat-queued-sends,
  20261117-side-chat-mic); no "Send to Trina" in threads (20261118-thread-no-send-to-trina); no "@" in an AI chat's
  main box (20261122-ai-session-no-main-mention); the model picker, "/" and "#" only in the AI chat's box; a room's "@",
  "@전체" question, link choice, typing line and phone edit mode; a phone's one-line box for the AI chat, rooms and
  answer threads.
- **Tests:** `web/test/unit/composer-shell.test.tsx` (keys, buttons, Esc), `web/test/unit/composer-single.test.ts`
  (the guard), `web/test/unit/device-pick.test.ts` (the file inputs now in `AttachMenu`), `web/test/e2e/composer-shell.spec.ts`
  (every box at 1440 and 390, light and dark).
- **Version impact:** minor (visible changes in every message box; no API, data or permission change).
