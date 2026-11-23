# AB4 leftovers: plain team-connection change cards, a folder share that finishes, chat pictures in a video, honest schedule cards, scheduled answers notify

- Date: 2026-11-23
- Status: accepted
- Supersedes: in [20261116-share-folder-tool.md](20261116-share-folder-tool.md) the M9 rule "where other people's words
  are in the turn it acts only when the asker's own message names the folder and every person" (now only with a guest
  among a shared chat's people); in [20261122-shared-chat-new-message-notices.md](20261122-shared-chat-new-message-notices.md)
  "Not a scheduled run's message" for the run's answer
- Branch: fix/ab4-asks-left (plan docs/AGENTS/plan/20261123-0006-ab4-asks-left.md; the owner-flow A/B run AB4,
  ~/b/qa-scenarios/ab4-permission-count.md F3, F5, F11, F1/F4/F7)

- **Ask:** the owner's own flows replayed before and after batch 4 still showed a card on every Repl-like write in a
  shared chat with the app's code open on it (F3), a folder share that asked "which folder, who?" and then refused the
  answer until 박준호 never got it (F5), an unasked "save 제품사진.jpg to 전사 공유 (16 people)?" card when making a video
  from an attached photo (F11), a schedule card saying an address "cannot be opened" that the run then opened, and a
  scheduled run's result in a shared chat that told nobody else.
- **Rule, a team connection's change (`integrations/connections/tools.ts` gate):** F3's stand-in was a team remote MCP
  connection. The rule of [20261122-connector-always-allow.md](20261122-connector-always-allow.md) stays: in a shared
  chat a change at a team connection's service asks every time (the team account is everyone's, its service holds
  other people's things, and other people's words in the chat can steer the call); the person's own connections (a
  local app such as Aside's Repl, their own remote MCP connection) keep Always for good. The card now says why in one
  plain line ("팀이 함께 쓰는 연결이라, 공유 대화에서는 바꿀 때마다 물어봐요."). For a call that reaches nobody else
  (`Sent.ownAct`): on the person's own connection or app its code, parameters and JSON are behind "자세히" (as an app's
  code already was); on a team connection, whose account others share, the labelled lines stay in view, a value longer
  than 200 characters (code, a page) shows as its length, and the exact text is one click away ("보내는 내용 그대로 보기";
  plan review). A call that reaches other people keeps "send" and its recipients in view.
- **Rule, share_folder in a chat with other people's words (`chat/share-folder.ts`):** its card shows the folder, what
  it holds and every person before anything changes, so "the asker's own message names the folder and every person"
  is no longer checked first: an answer on the AI's question ("which folder, who?") goes straight to that one card.
  The person's own Always for folder shares stays final. With a guest among a shared chat's people the old checks hold
  (the one limit kept everywhere). This goes further than #403 B4, which dropped them only under the person's Always;
  share_with_person keeps its file rule for now (F5's file sends worked on 0.14.0).
- **Rule, pictures in a promo video (`promo-video/spec.ts`):** besides the brand folder, a picture the person attached in
  this chat goes in as it is: one of the chat's own files (`chat:files/<id>/<name>`, everyone who sees the chat sees
  it) or their own upload (`users/<me>/.attachments/…`). The AI never copies it into a team folder for the video. The
  page names a chat file by its place; the app inlines it for whoever looks, through the chat file route
  (`web/src/lib/frame-files.ts`), and the MP4 render reads it as the chat's owner. A shared viewer's play and download
  checks it as a file of the chat they see (ChatFiles.open, never one held by the safety check); saving the MP4 to a
  team folder still weighs it as a source (the wider-audience card). The MP4 itself is still made only on a macOS
  development server; the Linux render stays with the srt image (DECISIONS "V").
- **Rule, the schedule card's addresses (`tools/schedules.ts`, `tools/url-gate.ts` opensUnderAllSites):** while this
  server's exit address is unknown, an address a run will open under the person's own "Allow all websites" (a plain
  address, no confidential chat, no guest among a shared chat's people) is said as "opened while 'Allow all websites'
  is on"; otherwise the card says runs cannot open it now and how to change that, in plain words (no "public address").
- **Rule, a scheduled run's answer (`chat/message-notices.ts` noteSharedAnswer `scheduled`):** in a chat shared with
  people or a project's shared chat it tells the others as a person's main message does (the unread number, a push, the
  desktop ring; mute, quiet hours and the room default as for every message), never anyone the answer is hidden from;
  it has no person as its writer (the push says "a new message"). Trina's live answers keep the number only.
- **Tests:** `tests/unit/b-connector-tool-always.test.ts` (team change card words, folded code, no Always, asked in a new
  chat; Always in a private chat), `tests/unit/b-share-folder.test.ts` (a marked chat: one card, then shared),
  `tests/unit/b-always-holds-everywhere.test.ts` (a shared chat another person wrote in: one card),
  `tests/unit/b-promo-video.test.ts` (a shared chat's photo: no team copy, the chat's people play it, a held file and a
  stranger do not; a private chat's own upload), `tests/unit/ab4-schedule-card.test.ts` (the card's words with and
  without "Allow all websites", what is never promised), `tests/unit/b-project-chat-message-notices.test.ts` (a
  scheduled answer rings for the other members, not the muted one), web `frame-files.test.ts` (chat file references).
- **Version impact:** patch (fewer and plainer cards, a share that finishes, a missing notice; no API or migration).
