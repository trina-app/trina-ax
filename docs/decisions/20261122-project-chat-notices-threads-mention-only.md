# Project chats tell their people of new messages; a thread reply rings only on a mention

- Date: 2026-11-22
- Status: accepted
- Supersedes: the "Left out: project-shared chats" part of
  [20261122-shared-chat-new-message-notices.md](20261122-shared-chat-new-message-notices.md); the default "on" of
  "내가 참여한 스레드의 답글" in "대화방 알림 설정" (docs/DECISIONS.md) and in
  [20261116-chat-answer-threads.md](20261116-chat-answer-threads.md)
- Branch: fix/project-chat-notices-threads-mention-only (the owner, 2026-11-22: "ㅇㅇ 그게 맞지. 스레드는 원래 멘션
  없으면 안오는거임"; QA TC-projnotice-1)

- **Ask:** project chats should tell people of new messages as chats shared with people do (#339), and threads should
  not notify without a mention, as in Slack.
- **Rule (project chats):** a person's message on the main timeline of a team project's shared chat gives every other
  person who sees it now (the project's readers; no guest but the chat's creator; nobody while its folder is in the
  trash) a notice: the unread number on the row and on the Projects rail (#350), the app icon, a push, a desktop notice
  and the sound. Each message is its own notice and push, grouped under the chat on the phone; one desktop notice per
  chat (TC-5585). Trina's answers raise only the number and never ring; the asker keeps the "finished" notice. "Mute this
  chat" and "@" in the message box work as in a people chat. A chat started "Only me" tells nobody. A member who never
  wrote there still gets the number after a reload (GET /api/chats?unread=1, the push badge).
- **Rule (threads, everywhere):** a reply in a thread rings (push, desktop notice, sound) only the people it mentions.
  "Replies in threads I'm part of" stays as the one opt-in for rooms and chats, now off by default (migration 437 turns
  it off for saved settings too: it was on by default and could only be turned off). The thread still shows as new in
  Mentions & threads: chat threads as before; rooms keep a followed reply as a quiet row when the switch is off (before,
  the switch off meant no row). A mention is pushed whatever the switch, also when it lands on a thread notice that is
  already open (it is pushed anew).
- **Known difference:** a project's linked room stays at 멘션만 by default (only mentions ring), while its project chats
  ring for every message, as the owner asked for chats.
- **Left out:** removing notices when someone loses a project (pushes check access before sending; the number shows
  only on chats they still see), per-row batching of the unread number in long project lists.
- **Tests:** tests/unit/b-project-chat-message-notices.test.ts; the updated thread and room notice tests.
- **Version impact:** minor (a new notice kind for project chats, a changed default, a data migration).
