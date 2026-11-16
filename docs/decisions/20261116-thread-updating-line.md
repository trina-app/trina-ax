# A thread says when its replies wait for an update

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/live-folder-button-and-thread-updating (QA TC-3886)

- **Ask:** while the server is updating, a reply in a thread on an AI answer waits (faint) and goes by itself once the
  server is back, but the thread did not say why.
- **Rule:** one plain line under the thread's box: "Trina is updating. Your reply will be sent when it's back." (ko
  "트리나를 업데이트하고 있어요. 끝나면 답글이 저절로 보내져요.", and id, ja, es, zh), written after the chat's
  `conn.updatingUnsent` but about a reply. It shows only while the window knows the server is updating
  (`web/src/lib/serverUpdating.ts useServerUpdating`, the same signal the chat's box and its waiting messages follow) and
  goes when `/api/health` answers again.
- **One slot:** it uses the single line of "You're sending fast" (QA TC-3887), as one component
  (`ThreadWaitLine` in `web/src/components/chat/ChatThreadPanel.tsx`). When both apply, the update is said, since it is
  what holds every reply; never two lines.
- **Left out:** room threads (`components/rooms/ThreadPanel.tsx`) keep the note on each waiting reply, as before.
- **Tests:** `web/test/unit/chat-threads.test.tsx` (no line, the line while updating, gone when back, it replaces the
  sending-fast line, a sentence in every language).
- **Version impact:** patch (one line of copy).
