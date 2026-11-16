# A card the person allowed does not come back for the same action and target in that chat

- Date: 2026-11-17
- Status: accepted
- Supersedes: none (narrows, for repeats only, the room-change card of docs/DECISIONS.md "대화방을 읽은 뒤 카드 줄이기",
  the connection write card of "Always allow on every card", the post_to_room card and the wider-audience card)
- Branch: fix/card-approved-once-per-chat (plan docs/AGENTS/plan/20261116-2111-card-approved-once-per-chat.md)

- **Ask:** the AI flow check of 2026-11-17 (tests/ai-scenarios, default mode: nobody picked Always allow) counted the
  same card again and again in one chat. FL-08: 9 prompts (up from 6); after a room read, fixing and re-stamping a quote
  asked a room card for every file of the answer, and the stamped copy for the team folder asked twice for one call.
  FL-12: 4 prompts (up from 2); a second "Create draft" card for the same recipient, then a Send card for the draft.
  The owner: "권한을 너무 많이 물어보면 진짜 극혐".
- **Rule:** the person's own yes on a server card ([이번만 허용], [보내기], [저장하기]; not Always allow, which has its own
  store, and never a text match of their message) covers the same kind of action to the same target in the same chat,
  for that person's own later turns in the app (web, desktop, phone; never a scheduled run, a Slack question or a
  restricted turn), for 12 hours at most and until the chat's session starts anew (an edited first message). Kept in
  `chat_card_approvals` (migration 413, `server/src/chat/card-approvals.ts`), next to the chat's other marks.

| Card | Same target (built by the server from the call) | Still asks |
|---|---|---|
| Room change after a room read (chat/turn.ts confirmRoomChange) | the same file: write, edit, make_file, edit_hwp, stamp_pdf's output (the path as the file layer reads it) | another file; a move, copy, rename, delete, a save from the web or a room; a skill or instruction file (every time); a save where more people can see than the person allowed (its own card) |
| Wider-audience save ("볼 수 있는 사람이 더 적은 내용을 읽은 뒤…") | the same folder with the same people able to see it (folderAudience), and only sources that card named (sourceKey; a newer part of a room is another source) | a new source, another folder, a folder whose readers or writers changed; a PowerPoint's bound save |
| Connection write (integrations/connections/tools.ts gate) | the same tool of the same connection at the same version, and every value of the call that may say where it goes (pinTargets: to, cc, channel, page, folder, any unknown key) is one the allowed call had; the text may differ | a new or added recipient, cc, page or channel; another tool; a web address, host name or long random-looking part in the text that is not one of those recipients; api_request; team files attached; a changed connection |
| Sending a draft | a tool named "send" (not share, publish, forward, invite, schedule) whose every value is the id a draft tool returned on a card the person said yes to, with no write naming that id since | a draft made without its own card (its words were never shown), a draft changed since, a send that adds anything |
| post_to_room | the same room or thread, the AI's text quoted, no note, no files choice, no "cannot see / cannot open" line, no new 1:1 chat | another room or thread; a note or own words (the person's name on the text); linked files; anything the card would say about who sees what |
| share_with_person | not covered | each share gives a person a file they could not open: a widening by itself |

- **Also:** stamp_pdf with an output, after a room read, now asks its room card and its wider-audience card as one card
  (widenOf), as write and make_file do ("one card per call"). Its step line says "allowed earlier in this chat" when an
  approval let it through.
- **Why this scope (the chat, 12 hours, the person's own turns):** a chat is the unit the person thinks in ("in this
  chat I said yes to that"); a per-answer scope left FL-08 and FL-12 as they were, a per-person scope would carry a yes
  into chats that read other things. Twelve hours covers a working day; a chat reopened the next day asks once more.
  The session reset drops everything with the other per-chat marks.
- **Rule A is unchanged:** Always allow stays final, and in a chat marked as having read other people's words the
  "no card after an explicit ask" skip stays off (docs/decisions/20261116-always-allow-final-rule-a.md). This rule is
  not that skip: it is the person's own answer on a card for that exact target, so it holds in such a chat too.
- **Accepted residual (injection):** in a chat with other people's words (a room, a mail, a web page), a planted
  instruction can make the AI repeat an action to a target the person already allowed in that chat: change the same
  file again, write again with the same tool to the same recipients, post again to the same room, save the same sources
  into the same folder. It cannot reach a new person, room, folder, page, channel or address, add a recipient, attach a
  team file, send a draft whose words the person did not see, or change a skill or instruction file without a card,
  because the target is computed from the call's own arguments on the server and compared as a subset of what was
  approved, never from what the AI says. The text of a repeated write can differ from what the card showed, as with
  Always allow for that one target.
- **Results:** FL-08 and FL-12 before and after: see the PR.
- **Tests:** tests/unit/b-card-approved-once.test.ts (room change, stamp, post, the store),
  tests/unit/c-card-approved-once-connector.test.ts (FL-12, what the same target is).
- **Version impact:** patch (fewer repeated cards; one additive table).
