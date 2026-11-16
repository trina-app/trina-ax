# Ask for access on a chat's or a project's link, as on a file's

- Date: 2026-11-16
- Status: accepted
- Supersedes: the "No access" bullet of 20261116-chat-share-copy-link.md (a teammate's link to a chat or project they
  can't see now offers Ask for access instead of the plain not-found page)
- Branch: feat/chat-project-ask-access (QA TC-4185 chats, TC-4186 projects; stacked on batch PR #1111)

- **Ask:** chats and projects got Copy link (#1107), but a teammate who is not on the share list just reads "can't be
  opened". Files already have Ask for access (20261116-file-share-push-gaps.md and the file share links plan). Do the
  same for chats and projects, with the same limits and push cap, revealing exactly what a file's link reveals.
- **What the page reveals:** what a file's link reveals to someone it does not open for, and nothing more. GET
  `/api/link-access/:kind/:id` answers `open`, `no_access` (`canAsk`, `askedAt`) or `unknown`. `canAsk: false` is the
  same answer for every reason (never shared, confidential, personal, locked, nobody left to answer, an owner or admin
  who adds themselves), and the page shows one plain line for all of them: "You can't ask for access to this. Ask the
  person who sent the link." `askedAt` only for an ask of the link's own kind (a chat's link never shows the waiting ask
  for its project, which would tie the chat to it). A shared chat of a project in the trash is `unknown`, as the
  project. The read is limited to 60 a minute per person (429) and never reads every account: `canAsk` stops at the
  first answerer, and the owner and admins are read by one query. Like a file link it tells a signed-in member that the id is a real
  chat or project (ids are random UUIDv7s, so this is no list of anything); never the title, the creator, who is in
  it, how many, or which project a chat belongs to. `GET /api/chats/:id` and `GET /api/projects/:id` keep their one
  404 body for hidden and missing alike (tests/unit/b-share-copy-link.test.ts still holds). Guests get 403, as on a
  file link, and keep the plain page. An address that was never a chat or project keeps the plain not-found page.
- **What can be asked for:**
  - a chat outside projects that its creator could share with people (chat/people-share.ts `peopleShareRefusal`):
    the creator answers. This includes a private ("Only me") chat: today's Share dialog shares it, so it can be asked
    for; its first share runs the dialog's own check (below).
  - a team project in `projects/<name>` whose members can be changed (`accessEditable`): its creator answers while
    they may change its members; else the active owner and admins who may (as a team file with no owner known).
  - a shared chat of a team project (its members see it): the ask is to join that project; Share makes them a member.
  - never (`canAsk: false`, the one plain line, no button, no reason): a chat of a personal project, a scheduled task's run, a
    room's side chat, a private (🔒) chat of a team project, any chat while safe operations are on or a confidential
    one, and a personal project. These are what the code refuses to share with people today, so a button would only
    lead to a refusal.
  - the owner or an admin on a team project they manage is "open" (the page loads it for them to manage, with Add me),
    and on a team project chat they keep the existing "add yourself in Projects" line: they never need to ask.
- **A request nobody can answer any more** (its chat moved into a project or deleted, its project trashed or gone, its
  answerers gone) is closed on the next read; one whose asker opens it now is approved.
- **Security review of #1140:** the no-ask reasons are no longer told apart (no `why`), `askedAt` follows the link's
  kind, trashed projects' chats are `unknown`, the read is limited and cheap, unanswerable requests close.
- **Who can't ask:** guests (403), switched-off and removed accounts (they cannot sign in; a waiting request of an
  asker switched off later is never pushed, and Share then closes it). Someone who already opens it gets `open` and
  the page loads; a waiting request of someone given access another way settles as approved when read.
- **Share:** goes through the dialogs' own saves, never a new path: a chat through `putChatAudience` with the current
  list plus the asker by name (the same checks: busy chat, 50 entries, safe operations; a first share or new people
  answer `confirm` with the check, which Activity shows in a confirm with the Share dialog's warning lines, and Share
  again carries the key); a project through `saveParticipants` with the current participants plus the asker (write,
  the one role a project member has; the rules hash checked). The chat's save already tells the asker ("shared a chat
  with you", pushed: a share by name); a project's says nothing to the person added, so they get `access.answered`
  (approved) with the project's name and link while they see it.
- **Decline:** the asker's Activity row says only "Your request for access wasn't approved." (no name, no link), as a
  file's decline. They may ask again (within the limits).
- **Limits and push:** the file requests' own, counted together over both tables: one waiting ask per person and
  target, `FILE_REQUESTS_PER_OWNER_DAY` (5) a day to one owner (a chat's creator or a project's creator), and
  `FILE_REQUESTS_PER_HOUR` (20) an hour in all. The push (`access.requested`, generic line "Someone asked for access to
  a chat or project.", ids only, opens `/activity/<notice id>`) follows the same switch as the file requests and shares
  `FILE_REQUEST_PUSHES_PER_DAY` (10 a day per person) with them (files/share-push.ts `requestPushesToday` counts both
  delivery tables). Requests from before migration 411 are never pushed.
- **The switch's name:** Settings › Notifications "File sharing" now covers asks to open a chat or project too, so it
  reads **Sharing** (ko 공유, ja 共有, zh 共享, es Compartir, id Berbagi); same key (`fileShares`), same column.
- **Tables:** the file tables do not generalise cleanly (`file_access_requests.share_id` is a foreign key to a file's
  link row, `file_share_notices.event_type` has a CHECK list), so migration 411 (B range) adds `access_requests` (a
  `kind` column, chat or project), `access_request_notices` and `access_request_push_deliveries`. 359, 360 and 363 are
  taken on open branches and 410 in batch/1116c.
- **Account removal:** the asker's requests and Activity rows go with the account (`access_requests.requester_id`,
  `access_request_notices.user_id` in the chat area's hook); `owner_id` (the limit's key) and `decided_by` stay,
  never shown (auth/account-removal.ts `KEPT_WITH_ACCOUNT`).
- **Left out:** the "no longer shared with you" and "no longer a member" pages keep their words (no Ask there); a
  personal project's Share (it copies the project into `projects/`) is not offered from Activity.
- **Tests:** `tests/unit/b-chat-project-ask-access.test.ts` (pages, ask, limits shared with files, Share with the
  check, Decline, settling, the team project chat, guests and switched-off askers, the push and its shared cap, the
  switch, account removal), the permission matrix (`tests/security/lib/access-request-cases.ts`),
  `web/test/e2e/chat-project-ask-access.spec.ts` (both pages, Requested, Activity Share and Decline, 1440 and 390,
  light and dark), `web/test/unit/push-worker.test.ts`.
- **Version impact:** API (three endpoints), schema (migration 411, additive, reader 1), push gateway text for the new
  code (an older gateway shows its generic "new notification" line).
