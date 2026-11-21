# Sharing findings from the multi-person scenario QA (TC-7041, 7042, 7046, 7047, 7049, 7050)

- Date (UTC): 2026-11-21 23:42
- Branch: `fix/sharing-sq-findings`
- Status: in progress
- Where: server/src/chat, server/src/rooms, server/src/notifications, shared/src, web/src. Why: fixes of existing
  sharing, project and notification features (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Bug fixes and wording; one optional API field each (old clients ignore them), no migration.

## Goal

Six findings from the scenario QA on dev 3d747563a (shots in the QA rows):

1. **TC-7041 (P2).** In a chat shared with people, a member asks "내 폴더 제안서 HTML로 PPT 만들어줘". The AI calls
   `glob` with `pattern: "users/qa-member/**/*.html"` and no `path`. A people-shared chat refuses any search without a
   path (`TurnExec.sharedSearchRefusal`: "needs a folder", it names only folders everyone may read), so the read card
   never gets a chance. The AI then says to use a menu item with a made-up label: the prompt names the label in the
   screen's language (English), the AI translated it into Korean, and "the menu at the top" is vague. In later turns it
   does not try again.
2. **TC-7042 (P2).** The Share dialog warns "This chat also used Direct messages and private channels, which <person>
   can't open" for a chat that only made a video or a docx. The source is the chat's **own** files: reading the chat's
   work folder or a chat file records `{type:'chat', id: <this chat>}` (chat/tools.ts, chat-file-tool). The check of the
   same chat counts it as a place the newcomer misses (`chatViewers` = the people in it now) and names it
   `{kind:'conversation'}` (share-places.ts). The widening list does the same (`fileAnswers`). Also the warning names
   everyone picked in the list who is not in the saved list, even a person already in the chat through a group.
3. **TC-7046 (P2).** "Make it a project" keeps 3 of 4 files "because not everyone here can see them", though all three
   people open them. The 3 files are AI posts (post_to_room) whose room copies have `origin = 'answer_copy'`.
   `stayReason` keeps every answer copy (plan 20261121-0619 "It is not a copy of a team file": a copy exists for
   members who cannot open the team original, so moving it would give the original's content to later project
   people). The reason text says "not everyone can see" for every reason.
4. **TC-7047 (P3).** A share notice of a chat that is no longer shared reads only "This chat is no longer shared with
   you." (no subject). Re-sharing the same day makes no new notice (one row per chat, person and day).
5. **TC-7049 (P3).** A Mentions & threads row for a message with text and a file shows only the text
   (`rooms/inbox.ts` sends `files` only when the text is empty).
6. **TC-7050 (P3).** A guest whose AI cannot answer (AI "own" on an API-only team) gets a red "AI isn't available for
   guests in this team." with Try again, the step "The chosen AI is off; answering with the team's default AI", and the
   box "AI isn't on for you. Ask the person who invited you." under it.

## Scope

In:

1. **Search with the folder in the pattern.** A `glob` call without a path whose pattern starts with plain folder
   names (no `* ? [ ] { } !`) runs as `path` = those folders, `pattern` = the rest (the same files: glob matches the
   pattern relative to `path`). Done once, before the people-chat refusal, the project-folder default and the read
   card (both call sites in chat/tools.ts), so the card asks for `users/<me>` and the search runs after yes. Private
   chats are unchanged (it is only in the shared branch).
2. **Prompt and refusal words (people-shared chat).** Say that the asker's own folder (`users/<id>/`) can be searched
   and read here by giving its path, and that the server asks them on a card first. The "Not searched" refusal says
   the same ("or the folder you mean, such as the user's own folder, as path"). The "continue privately" lines name
   the menu as "the menu that opens from this chat's title" and tell the AI to quote the label exactly as written (it is
   the button's text on the person's screen, so it is not translated).
3. **Share check without the chat's own files.** In `checkAudience` and in `wideningAnswers` with a chat target, a
   `{type:'chat'}` source of **that same chat** counts as seen by the people being added (they see the chat's files
   once they are in it; an answer hidden from someone stays covered by `hidden` as today). A chat source of another
   chat is unchanged.
4. **The warning names only people who miss something.** `ShareCheck.warnSubjects` (optional): the picked entries
   (`user:<id>`, `group:<id>`) among the newly added ones that bring in at least one person who misses something. The
   dialog names only those; without the field (an older server) it names all added picks, as today.
5. **Make it a project: AI posts of the sender's own files move.** An answer copy moves (when everything else passes,
   `not_seen` included) when its message's kept scope (`source_scope.attached`) names this file's source as a path in
   the **sender's own folder** (`users/<sender>/…`): the sender sent their own file on purpose (post_to_room card or
   "Send to a chat room"), the same as an upload of it. A copy of any other team file stays (the plan's reason). The
   info carries `filesStayingCopies` (how many stay because they are copies of team files); the dialog says each
   reason in its own line: "not everyone here can see them" only for those, "copies of team files stay in the
   conversation, so people added to the project later don't get them" for copies.
6. **Notices.** A gone share notice says "A chat from {name} is no longer shared with you." (generic "A chat is no
   longer shared with you." without the name). No title: the chat may have been renamed after they lost it. A re-share
   to someone who lost the chat replaces that day's row with a new one (new id: unread, pushed by the same rule as a
   first share); the one-row-a-day rule stays for anything else.
7. **Feed row files.** `rooms/inbox.ts` sends `files` (count) and `fileName` (the first file's name) for the newest
   message also when it has text; the row shows the text, then "📎 name" (+ "+N" for more) on its own small line.
8. **Guest without AI.** Server: the guest check runs before the "chosen AI is off" step, so a refused guest has no
   such step. The step reads plainly: "The AI picked for this chat is turned off, so your team's usual AI is
   answering." (6 languages). Web: a guest's failed answer for a no-AI reason (`guest_no_ai`, `no_credential`,
   `credential_unusable`, `engine_missing`) is a calm notice (no red, no Try again); while the guest box under the
   chat already says it (useGuestNoAi), the answer shows no second notice.

Out: the other findings of the same run (versions, edit_pdf, footer line, step paths, video fonts) belong to other
agents; `server/src/engine/api-honest.ts` is not touched. A chat title snapshot for gone notices (needs a migration).

## Steps

1. Plan (this file), independent plan review, notes applied.
2. Server: chat/tools.ts + turn.ts (glob prefix), prompt.ts, audience-check.ts, widening.ts, people-share.ts
   (warnSubjects), rooms/file-moves.ts + make-project.ts, notifications/service.ts, rooms/inbox.ts, turn.ts guest step,
   shared step label and API fields.
3. Web: ChatShareDialog names, MakeProjectDialog lines, Notifications/Activity gone text, RoomNoticeRow + Activity
   file line, Messages guest notice. i18n keys in en/ko/ja/zh/es/id.
4. Tests: b-share-chat-people (glob prefix with card, gone text, reshare notice, warnSubjects), the check without the
   chat's own source, b-make-project / b-room-file-moves (own-file answer copy moves, team copy stays, counts), inbox
   files with text, guest step order; web unit tests for the warning names and the guest notice.
5. typecheck, check:prepush, area tests, web unit tests (Bun 1.3.12), full tests/unit and tests/security once.
6. Visual check on a new private copy of the QA team; independent code review; one PR into dev (not enqueued).

## Decisions

- `docs/decisions/20261121-make-project-own-file-copies.md`: an AI post of the sender's own file moves with "Make it a
  project" like their upload; copies of other team files stay. Changes plan 20261121-0619 "Which files move" for that
  one case.

## Risks

- Security: (1) adds no access: the lifted path goes through the same read card as a path the AI gives. (3) only drops
  the chat's own source for that chat's own share; hidden answers stay refused. (5) moves only files whose source was
  the sender's own folder, which they chose to send to these people. (6) a remove/add loop gives one notice per add.
- No migration. API fields optional. Five languages plus Indonesian for every new string.

## Tests

As in step 4; plus the QA copy walk at 1440 and 390.

## Result

(filled at the end)
