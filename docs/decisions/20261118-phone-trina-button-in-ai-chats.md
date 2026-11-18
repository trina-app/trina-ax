# An AI chat's header has no ✦ on a phone either

- Date: 2026-11-18
- Status: accepted
- Supersedes: the phone part of [트리나에게 묻기는 ✦](../DECISIONS.md#트리나에게-묻기는---ask-trina-has-trinas-mark-fixask-trina-icon-2026-11-10-product-owner)
  (the new-chat ✦ "on the new-chat button of a phone AI chat's header") and of "AI chat on phones: one bar with back,
  the title and new chat" (31c3306d0)
- Branch: fix/phone-trina-button-in-ai-chats (the owner, iPhone app)

- **Ask:** in a shared project AI chat on the iPhone app the header showed ‹, the project, the title ▾, the people
  icon, Share and an orange ✦ at the right. The owner: is it needed? I am already talking to Trina here, and the
  computer has no such button.
- **What it was:** "새 채팅" (트리나에게 묻기): it opened the 트리나 tab's empty box. It was not a side chat; a computer
  never showed it in a chat's header (`md:hidden`; there the sidebar's first row starts a chat).
- **Rule:** an AI chat's header (private, shared with people, a team project's) has no ✦ at any width. ✦ in a
  header means "ask Trina beside this conversation": the side chat of a room or a DM (and of a thread in them). Those
  keep it. The same mark meaning "new chat" in one header and "private side chat" in the next was the confusion.
- **A new chat on a phone** stays one tap away: ‹ goes where the chat was opened from, else the 트리나 tab, whose box
  is the new chat; the tab bar shows there. A private question about a shared chat stays in the title's ▾
  ("Continue in a chat only you see"), as on a computer.
- **Left out:** no new entry anywhere; nothing changes on a computer, in rooms, DMs or threads.
- **Tests:** `web/test/e2e/phone-ai-chat-header.spec.ts` (390 and 1440: private and shared project chats have no ✦
  and keep Share; ‹ reaches the box; a room and a DM keep their ✦), `web/test/e2e/phone-tabs-v2.spec.ts`.
- **Version impact:** patch (one button less on phones; no text, API or data change).
