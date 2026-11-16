# A teammate's link in a room, saved from the side chat, with one prompt at most

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (narrows the room card of "대화방을 읽은 뒤 카드 줄이기" for an explicit save, and widens rule ① of
  url-gate.ts for a side chat's own room)
- Branch: fix/room-link-save-one-prompt (QA TC-3830, TC-3831, TC-3832, TC-3833)

- **Ask (the owner, 2026-11-16):** a teammate posted "일요일 회의록이에요 https://tiro.ooo/s/…?utm_source=…" in a room.
  The owner asked the room's ✦ side chat to save the meeting notes and met five prompts: the address card twice
  ("an address that wasn't in this chat … long strings"), two save cards, and the "Send to thread" dialog saying the
  answer holds content from My files that 4 people can't see.
- **Why each came:**
  - the room's messages reach the AI through room_read, and the gate only knew addresses the person typed, allowed or
    learned from pages and searches, so the room's link was "not in this chat"; the AI also dropped the `?utm_…` part,
    so the address it asked for matched nothing exactly, and a second call asked again;
  - after a room read every change waits for the room card, also the save the person had just asked for;
  - the notes were saved into the person's own folder, so the answer's link was a file 4 people could not open.
- **What changes:**
  - **The side chat's room counts as this conversation (url-gate.ts `sideRoomUrls`).** Addresses in the messages of the
    room a ✦ side chat belongs to are learned links: they open without a card within the link budget, as a page's links
    do. Only messages the person sees there (rooms/store.ts SEE_SQL: from when they see the room, no hidden answer)
    and written by people: not the room AI's messages nor answers shared from an AI chat, whose text a hidden
    instruction may have filled with an address that carries data. They are other people's words, so they are not
    "typed": the budget applies, and an address that holds what the AI sent asks (the echo rule, webEcho).
  - **Tracking parts do not make another address (`sameLink`).** An address that is a typed, allowed-here or room
    address with only tracking query parts left out (`utm_*`, `fbclid`, `gclid`, `msclkid` and the like) or a trailing
    slash is that address. Never the other way round: a part the known address does not have still asks, since it
    could carry data. So an address allowed once on a card is not asked again in the chat.
  - **An explicit save adds a file without the room card (turn.ts `askedToSave`, `newPlainFile`).** When the person's
    own message of this turn asks to save (저장 but not 저장소, 파일로, 기록해, save, simpan, 保存, guardar; not "저장하지
    말고", "don't save"; never a scheduled run's task text or a message the app sent) and the call writes a NEW file
    inside a folder where no more people can see it than can see what the chat read (no wider-audience card), the room
    card is skipped for that call only. An existing file, a skill or instruction file, a hidden name, a project or
    managed folder, a file at the team root, or a save that widens still asks. A room message steering this can only add a file the same people could read anyway.
  - **Where the side chat saves room content (side-room.ts `saveInFor`, prompt.ts sideRoomSection).** Unless the person
    names a place: a team room's group folder, the Everyone room's shared/, and for a 1:1 or group chat the person's own
    folder (no team folder is just those people).
  - **"Send to thread" sends the file the answer made (answer-share.ts `madeHereOnly`).** On the button's first press,
    when the only thing that would ask is linked files that this answer's own turns wrote new with the write tool or
    make_file (no file there before, not a copy, move, conflict copy, a file built from other files or a download, and
    unchanged since) and, with those files attached, nobody in the room would miss anything the answer used, the files go as
    copies and there is no dialog. Anything else read that some member cannot see keeps the dialog as before.
  - **"Always allow" on the address card:** the room's link no longer meets a card. The card of an address with a
    random-looking part (the tiro link has one) still offers no "Allow all websites": such a part can carry data, and
    the switch never covers it ("Allow all websites covers the AI's web reads"). Plain addresses keep offering it
    (and while the exit address is unknown too, in fix/always-allow-more-cards).
- **Result on the flow (tests/ai-scenarios FL-28, mock page behind a public tunnel):** see the PR.
- **Tests:** tests/unit/room-link-gate.test.ts, b-chat-rooms-fewer-cards.test.ts ("an explicit save"),
  b-answer-share.test.ts ("a file this answer itself made").
