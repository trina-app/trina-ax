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
  restricted turn, nor a chat shared with others now, where a yes counts for that card only, as Always allow counts there only for the person's own ask), for 12 hours at most and until the chat's session starts anew (an edited first message). Kept in
  `chat_card_approvals` (migration 413, `server/src/chat/card-approvals.ts`), next to the chat's other marks.

| Card | Same target (built by the server from the call) | Still asks |
|---|---|---|
| Room change after a room read (chat/turn.ts confirmRoomChange) | the same file: write, edit, make_file, edit_hwp, stamp_pdf's output (the path the tool writes, as the file layer reads it; any of these tools, so an allowed small edit covers a later rewrite of that file) | another file; a move, copy, rename, delete, a save from the web or a room; a skill or instruction file (every time); a save where more people can see than the person allowed (its own card) |
| Wider-audience save ("볼 수 있는 사람이 더 적은 내용을 읽은 뒤…") | the same folder with the same people able to see it (folderAudience), and only sources that card named (sourceKey; a room read from an older message on is another source) | a new source, another folder, a folder whose readers or writers changed; a PowerPoint's bound save |
| Connection write (integrations/connections/tools.ts gate) | the same tool of the same connection at the same version, with exactly the same recipient-like argument paths as the allowed call (pinPairs: to, cc, channel, page, folder, flags, any unknown key) and under each only values it had there; the text may differ | a new or added recipient, cc, flag or setting, or one left out; another tool; a tool that shares, publishes or changes access, invites or adds members (never kept); a web address, host name or long random-looking part in the text that is not one of those recipients; a write too large for a card; api_request; team files attached; a changed connection |
| Sending a draft | a tool named "send" (not share, publish, forward, invite, schedule, permission) whose every value is the id a draft-making tool (create/new/save … draft) returned at its answer's top level on a card the person said yes to, not an id the call itself named, with no write naming that id since in any chat (an api_request too; the id anywhere in a value) | a draft made without its own card (its words were never shown), a draft opened or listed (get/list/search), a draft changed since, a send that adds anything |
| post_to_room | the same room or thread with the same members, the AI's text quoted, no note, no files choice, no "cannot see / cannot open" line, no web address or host in the text, no new 1:1 chat; kept only once the post went | another room or thread; a member who joined since; a note or own words (the person's name on the text); linked files; a link; anything the card would say about who sees what; any post once the person deleted one this chat posted there |
| share_with_person | not covered | each share gives a person a file they could not open: a widening by itself |

- **Also:** stamp_pdf with an output, after a room read, now asks its room card and its wider-audience card as one card
  (widenOf), as write and make_file do ("one card per call"). Its step line says "allowed earlier in this chat" when an
  approval let it through.
- **Why this scope (the chat, 12 hours, the person's own turns):** a chat is the unit the person thinks in ("in this
  chat I said yes to that"); a per-answer scope left FL-08 and FL-12 as they were, a per-person scope would carry a yes
  into chats that read other things. Twelve hours covers a working day; a chat reopened the next day asks once more.
  The session reset drops everything with the other per-chat marks.
- **Not tied to the team's Always-allow switch:** an admin who turns off "Always allow" still gets these repeats; they
  are the person's answer for one exact target in one chat, not a standing choice, and they end with the chat's day.
- **Known limits (follow-ups):** an approval kept in a branch of the chat that an edit of a later message discarded
  still counts until the session starts anew; a draft changed in the mail app itself is not seen (the send then goes as
  the service has it); a folder renamed away and made again with the same name and the same people is the same target.
- **Independent review (Opus):** four must-fix items are in: no draft recorded from a card that did not show it (only
  create-style tools, the top-level id, not an id the call named); a draft dropped on any write naming it in any chat
  and on api_request; recipient values compared per argument path with the same set of paths, and share, permission,
  invite and publish tools never kept; skill and instruction files never kept (make_file "CLAUDE" is CLAUDE.md). Also
  in: stamp_pdf's target is the file the tool writes, the size limit comes before an approval, a post's approval is kept
  only once it went and names the room's members and no link, a drop that cannot read its rows drops them all, shared
  chats are left out.
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
