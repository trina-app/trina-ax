# A member shares their own file with chosen people, Drive style: a link that opens for them, "Ask for access" for others

- Date (UTC): 2026-11-15 14:07
- Branch: `feat/file-share-links`
- Status: draft (plan only; for plan review before any code)
- QA: TC-3093
- Where: Team AX core (`server/src/team-files/`, a new `server/src/files/shares.ts`, `server/src/tools/index.ts`, a
  new `server/src/chat/share-with-person.ts`, `server/src/notifications/`, `server/src/admin/`,
  `server/migrations/`, `shared/src/api/files.ts`, `shared/src/app-links.ts`, `web/src/pages/` (Files, a new
  `FileLink.tsx`), `web/src/components/` (the Share dialog parts), `web/src/i18n/*`, `desktop/src/common/address.ts`,
  `mobile/` (P2), `docs/DECISIONS.md`, `docs/site/`). Why: files, permissions and sharing are core
  (docs/REPOSITORY-RULES.md).
- Version impact: **minor**. A new feature, new endpoints and an additive migration (reader level 1, no roll-back
  problem).

## Goal

The owner's decision of 2026-11-15 (final, designed here, not reopened):

- A member can share **their own file** (in their personal folder, and anywhere else they own) with chosen people or
  groups, as Google Drive does. The link then opens for those people.
- Anyone else who opens the link gets a plain **Ask for access** page.
- The file's owner gets the request and approves or declines it in one step.
- Removing access takes it away at once.
- This overrides "only the owner and admins share" for a member's own files. Admin rules for team folders stay as they
  are.

**The case that started it.** In a shared chat a member asked the AI to share two photos with a teammate. `share_file`
(`server/src/tools/index.ts:144-157`) only builds `/files/view?path=…`, which grants nothing; its description says "a
link never shares more than they may see", which the AI read as "sharing". The teammate opened it and got "The file can't be
found, or you don't have access to it." A computer upload in a shared chat lands in the project folder, so the photos
were most likely a **team-folder** file the member added, not a personal one. A personal-folder-only first release
would not fix the case; P1 covers both.

**Non-developer check:** "Share "photo.jpg" with Jun · Can view". "You need access · Ask for access". "Jun asked to
open "photo.jpg" · Share · Decline". Each reads in three seconds and matches what Drive users already know.

## Decisions taken in this plan (each with why; the review may change them)

1. **What "own" means.** No file has an owner today (no files table, no owner column; checked). A person may share a
   file when they can **edit** it now and either
   - it is under their personal folder `users/<me>/`, or
   - they **added it**: the earliest `create` / `upload` in `file_events` for the file, followed back through moves
     (`movedFrom`), is theirs (`creatorOf(path)`, new, in `files/shares.ts`). Unknown (an old file, a file made on the
     disk outside the app) = not theirs.
   The owner is frozen on the share row when it is made (`owner_id`), so a later move by someone else does not make
   the mover the owner. Owners and admins may share any team file (they already change folder access); they never
   reach another person's personal folder this way (unchanged: `users/<id>/` is private to its person, admins too).
2. **Folders are not shared this way.** File grants are on files only. Folders keep #787's Share dialog (owner and
   admins). Why: a folder grant is a folder rule; #787 decided who writes those.
3. **View only for now** (open, preview, download; no edit, no re-share). Why: an edit would write versions into
   someone's personal folder history and needs conflict and history rules of its own; Drive's default is Viewer too.
   The column has a CHECK list so Editor can be added later without a rebuild (new value, new migration).
4. **The link is an id, not a path: `/f/<id>`.** `id` = 16 random bytes, base64url (22 characters), made once per file
   on the first Share or Copy link, stable through renames and moves. Why: a path link breaks on rename and shows the
   folder names (`users/<id>/이직 서류/…`) to anyone it is forwarded to.
5. **The request page names nothing.** Not the file name, not its type, not the owner. Every case that is not "you may
   open it" (no such id, the file gone or in the trash, no access) answers the same way, in the same time, with the
   same page. Why: links get forwarded (into rooms, out of the team); a file name can be the secret ("resignation
   letter.pdf"); a different answer for "exists" would let ids be probed. Drive does the same. After the owner shares
   it, the notice names the file (they chose to).
6. **Guests: no in P1.** The picker leaves guests out, the server refuses them, and a guest who opens a `/f/` link gets
   the plain "You can't open this file" page without Ask (a guest may not ping members of places they are not in).
   Why: a guest reaches exactly one room or project (owner, 2026-11-14); a file share would be a second place, and the
   guest P1 is deny-by-default with one test per leak path. P2 (optional): a guest who is already in a room or project
   the sharer is in (`auth/guests.ts sharesPlace`), with a "Guest" tag and one warning line.
7. **No "General access" for files.** A file link is always Restricted: people with access already (by folder rules)
   plus the people and groups added. "Anyone in the team" stays a folder thing. Why: lean, and it avoids a second way
   to open a folder's content to everyone.
8. **Team folders keep their rules; a file grant adds one file.** Someone given a team file sees that one file, not
   the folder (no listing, no path, no siblings). This is the shared-drive idea of sharing one file with a non-member.
   A team switch (Admin › Team settings, "Members can share files they own", **default on** per the owner's
   "switches default on") lets admins turn it off.

## Scope

In (P1, the smallest release that fixes the case):
- Data model and migration; the `/f/<id>` link and its endpoints; the request page; the request notice with Share /
  Decline in Activity, plus push; the file Share dialog; Copy link for files; "Shared with me" in Files;
  `share_with_person` and a true `share_file`; audit rows; the team switch with "Remove all file shares"; desktop
  opens `/f/` in the app window; six languages, English first.

Out (P2 and later): Admin's list of every file share with per-row Remove; phone universal links for `/f/*` (needs a
store build); the recipient's AI reading a file shared with them; guests in a shared place; Editor; groups of files
(several files in one link); "Remove from my list" for recipients; email (the server sends no email today).

## Data model

Migration **`354_c_file_shares.sql`** (component C owns files: `301_c_files.sql`, `file_versions`, `trash_items`;
C's range is 300–399 and its highest on dev is 353; no open branch has 354+, checked 2026-11-15. Re-check before merge
per docs/WORKPLAN.md §4 and renumber if taken). Additive only, `-- min_compatible_reader: 1`, explicit columns, FKs
`ON DELETE CASCADE`.

```sql
CREATE TABLE file_shares (            -- one row per shared or linked file
  id TEXT PRIMARY KEY,                -- the link id (22 chars, random)
  path TEXT NOT NULL,                 -- current path, rewritten by moves like file_versions.path
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,  -- NULL: a team file with no known owner (requests go to owner/admins)
  state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','trashed')),
  trash_id TEXT,                      -- trash_items row while trashed
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX file_shares_live_path ON file_shares(path) WHERE state = 'live';
CREATE TABLE file_share_grants (
  share_id TEXT NOT NULL REFERENCES file_shares(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('user','group')),
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'view' CHECK(role IN ('view')),
  granted_by TEXT NOT NULL, granted_at TEXT NOT NULL,
  via TEXT NOT NULL CHECK(via IN ('dialog','ai','request')),
  PRIMARY KEY(share_id, subject_type, subject_id)
);
CREATE TABLE file_access_requests (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES file_shares(id) ON DELETE CASCADE,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,                       -- at most 500 characters
  state TEXT NOT NULL CHECK(state IN ('pending','approved','declined','closed')),
  created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT
);
CREATE UNIQUE INDEX file_access_requests_one_pending ON file_access_requests(share_id, requester_id) WHERE state = 'pending';
-- notices: file_share_notices (event_type IN ('file.shared','file.access_requested','file.access_answered')),
-- the same columns as service_request_closed_notices (353); file_share_push_deliveries like 351_c_chat_share_push.
```

- **Rename and move.** `TeamFiles.move` (`team-files/service.ts:769-840`) rewrites `file_shares.path` in the same
  transaction as `file_versions.path` (exact match for a file, prefix for a folder move). Copy makes a new file: no
  share follows it.
- **Trash.** `TeamFiles.remove` sets `state='trashed'` and `trash_id` (grants kept). Owner: the link says "This file
  is in the trash" with Restore if they may. Everyone else: the plain no-access page. Restore sets `live` and the new
  path. Purge (`purgeTrash`) and `forgetRecordsUnder` delete the share row; grants, requests and notices go with it.
- **Overwrite.** A new version of the same path (save, upload over it) is the same file: the share stays (Drive's
  "new version"). Delete-then-new-file at the same name: the old row is trashed or gone, so the new file starts
  unshared.
- **Changes on the disk outside the app** (desktop sync, box shell): the existing move and delete events are the only
  signal; a share whose path no longer exists answers "no access" and is repaired by the next event, never re-pointed
  by guess.
- **People and groups.** Group grants are read live (a person who leaves the group loses the file). A disabled or
  deleted account reaches nothing; a deleted owner's personal files go with them (CASCADE).
- **Who may open (`FileShares.canOpen(share, principal)`)**: the path is live, and either the normal permission
  function gives read (`RuleSet.access`, unchanged) or a grant names them or one of their groups, and they are not a
  guest (P1), and the owner can still edit the file (an owner who lost access to the folder stops sharing it).
  `RuleSet.decide` is **not** changed: the file grant is checked only on the id endpoints, so #787's permission
  function, its tests and `tests/security/folder-sharing.test.ts` stay as they are, and a grant never shows a folder,
  a sibling or a path.

## Link and endpoints

- `GET /f/:id` (web route, signed in; signed-out goes to sign-in and back). `GET /api/files/shared/:id` answers
  `{ status: 'open', name, size, kind, owner, path? }` (path only for people who reach it by folder rules) or
  `{ status: 'no_access', canAsk, asked? }`; the same 404-shaped answer for every other case. Content, preview and
  download by id: `/api/files/shared/:id/{content,download,preview}`, each checking `canOpen` on every request (a
  removed person loses it on the next request; an open preview shows the no-access page on refresh).
- The preview reuses `FileBody` with an id source (no path in the recipient's URL or panel).
- `POST /api/files/shared/:id/request { message? }`: always answers "sent" for an id that does not exist too, and
  stores nothing then. `POST /api/files/shared/:id/requests/:rid/{approve,decline}` (owner, or owner/admins for an
  owner-less team file). `PUT /api/files/shares { path, add[], remove[] }` from the dialog.
- **Rate limits.** Requests: 20 per person per hour team-wide (`auth/rate-limit.ts RateLimiter`, the DB-backed one);
  one pending request per person per file (a second press says "You already asked"); after a decline they may ask
  again, but the owner gets at most one notice per person per file per 24 hours (the notice is re-armed, not
  duplicated). Pending requests close after the inbox's 30 days (`closed`). Grants: the dialog and the AI take from the
  room sending budget (`takeSendToken`), as chat sharing does, so a share is no free probe of who exists.

## UI (lean: say what goes, reuse shared parts)

Every list and row uses the shared `ListRow` / `ListSection` / `ListIcon` and type tokens; no new px sizes.

1. **Share dialog for a file** (Files row ⋯ "Share", the preview panel's ⋯, phone bottom sheet). Shown only to people
   who may share that file; others see Copy link only. Built from the chat Share dialog's parts and the one-press
   design planned for TC-3092 (`feat/share-dialog-one-press`, plan `20261115-1400-share-dialog-one-press.md`): the
   people and groups field with faces (`ProjectParticipants` picker; a member is offered only their own groups), the
   inline `ShareWarning` line while picking, and **one press** (Share saves; no "Share anyway"). Contents, nothing more:
   - Title: `Share "photo.jpg"`.
   - Field: "Add people or groups".
   - "People with access": the owner row ("Owner"), then each person or group with "Can view" and Remove access.
     A team file adds one grey line "People who can open the folder can open this file too" (no list of them).
   - One grey line from `ShareWarning` only when true: "Jun can already open this file", "Only this file: they won't
     see the rest of the folder".
   - Footer: Copy link (secondary), Share / Done (primary).
   Not added: General access, Notify toggle, roles menu (only one role), message box.
2. **Copy link** for files (Files row ⋯ `file-copy-link`, the preview panel, the image viewer, chat attachment menu)
   gives `/f/<id>` (made on first use). Toast, true for each case: "Link copied. People with access can open it." On
   one's own unshared personal file: "Link copied. Only you can open it until you share it." with **Share…**. Folders
   keep their current link (no request flow for folders).
3. **The link page** (`web/src/pages/FileLink.tsx`): with access, the file preview as today plus "Shared by Mina"
   for a grantee. Without: an icon, "You need access", "Ask for access, or sign in with an account that has it.", an
   optional message (placeholder "Add a note (optional)"), [Ask for access]. After: "Request sent. You'll get a
   notice when it's answered." Coming back while pending: "You asked on Nov 15. Waiting for an answer." Guest: "You
   can't open this file. Ask the person who sent the link." with no button. Built like the chat 404 page
   (`pages/Chat.tsx:460-495`), centered card, full width at 390.
4. **The owner's notice** in Activity (new kind `file.access_requested`, in the Requests chip for everyone who gets
   one, not only admins): "Jun asked to open "photo.jpg"", their note quoted, inline **Share** and **Decline**
   (the `HandoverNoticeExtras` pattern, `components/handover/HandoverNotice.tsx:63`). After: "You shared it with
   Jun" / "Declined". Push: "Someone asked to open a file" (gateway text carries no names; tap opens the notice).
5. **The recipient's notices**: `file.shared` "Mina shared "photo.jpg" with you" (Open), pushed; `file.access_answered`
   for a decline: "Your request to open a file wasn't approved." (no name, nothing to act on). An approve sends
   `file.shared`.
6. **Shared with me** in Files: one row in the Files side column ("Shared with me", phone: a section in the Files tab)
   opening a flat list of files shared with me by a grant, newest first: icon or thumbnail, name, "Mina · Nov 15".
   Empty state: "Files people share with you appear here." No folders, no sorting menu, no grouping.
7. **The owner's own row** in Files gets the existing "shared" people glyph when a file has grants (no new chip).
8. **Admin › Team settings**: "Members can share files they own" (on) and, for the team owner, **Remove all file
   shares** (confirm: "Remove access for N people to M files? Links stop working for them at once."). P2: Admin › Folder
   permissions gains "Files shared one by one" (owner, shared with, file name or "Personal file", date, Remove).

## AI

- **`share_with_person(paths: string[] (1-10), people: string[], note?)`** in a new `server/src/chat/share-with-person.ts`.
  It acts as the turn's sender ("A turn is its sender's": `livePrincipal()` on every call). People by
  `rooms/reader.ts findPeople` and groups by `project-members.ts matchName` (several matches: nothing is shared, the AI
  gets up to 10 `person:<id>` candidates to ask, as `post_to_room` does). Refused with why and what to do: a folder
  ("an admin shares folders in the folder's Share dialog"), a file the sender does not own or only views ("only its
  owner can share it; send them a link to ask"), a guest, oneself, a disabled account, the team switch off.
- **Card** (`ask_user`, `origin: 'server'`, shown only to the sender: `showCard` publishes to `spec.userId`):
  `Share 2 files with Jun?` the file names, "They'll be able to view them.", [Share] [Don't share]. `withAlways` with a
  new kind `file_share` in `CARD_ALWAYS_KINDS` (owner rule: the option is on the first card, always allow ends the
  asking). On yes every check runs again and the plan's key must match (a changed group or owner: refused, "ask
  again").
- **Shared chats and chats others wrote in.** The tool is offered (unlike `post_to_room`), with these guards:
  - Another member's message starts **their** turn with **their** access, so it can only ever share their own files.
  - When `exec.shared` or `exec.otherAuthors`, each recipient must be named in the sender's own message of this turn
    (`project-members.ts mentioned`, honorific rules included), and each file must be one the sender attached, named,
    or the AI made in this turn. Otherwise refused ("say who to share it with in your own message"). This is a hard
    check, not a card, so Always allow does not weaken it.
  - Never offered: scheduled runs, approved template runs, restricted runs, sub-agents (`PARENT_ONLY_TOOLS`),
    questions from Slack, confidential chats.
- **After the share** the tool returns each `/f/<id>` link and the AI replies with them as Markdown links. In a shared
  chat everyone sees the reply; the link opens only for the people given access and those who already have it.
- **`share_file` becomes true.** Description: "Get a link the user can open or pass on. It gives nobody access: it
  opens only for people who can already open the file. To let a teammate open one of the user's own files, use
  share_with_person." For a file it returns the `/f/<id>` link (the request page then works for others); folders keep
  the old link.
- Prompt: one sentence in the files rule when the tool is present ("share with a teammate" means
  `share_with_person`; say it is shared only when the result says so).

## Phone and desktop

- **Desktop:** add `/f/:id` to `PAGE_PATH` (`desktop/src/common/address.ts:42`) so a `/f/` link clicked in the app or
  sent through `trina-ax://open?url=` opens in the app window.
- **Phone (P2, needs a store build):** `APP_LINK_PATHS` gains `file: '/f/*'` (`shared/src/app-links.ts:25`), the AASA
  components and the Android `pathPrefix /f/` filter (`mobile/app.config.ts:79`), `readAppLink` maps `/f/<id>` to
  that entry path instead of `/` (`shared/src/team-link.ts:182-193, 336`; keep the mobile copy byte-identical), and the
  trina.app root Worker's file is regenerated from `app-links.ts`. Until then the link opens in the phone's browser,
  which works (signed in or sign-in).
- Push taps: `registerPushPath` for the two pushed kinds (`/activity?n=<id>` and `/f/<id>`).

## Audit, admin overview, emergency revoke

- Rows (`admin/audit.ts audit()`): `file.share` (actor, share id, `{ people: n, groups: n, via }`), `file.unshare`,
  `file.access_request` (never the note), `file.access_approved`, `file.access_declined`,
  `file.shares_removed_all` (team owner, counts). A personal file is named "a personal file" to admins
  (`redactPersonal`, as today); team files by path. Who received access is shown (it is a permission change).
- Team owner's emergency revoke: the switch off stops new shares and hides Share for members (existing grants keep
  working); **Remove all file shares** deletes every grant and pending request at once. Disabling an account ends its
  shares (owner check in `canOpen`); handover leaves them to end with the account.
- P2: the admin list with per-row Remove and a per-person "Remove all shares by Mina".

## States (QA rows: one case per row, every surface)

For each: owner, admin, member, guest; 1440 and 390; light and dark; en first, then ko, id, ja, es, zh; and the words
true for that state.
- Share dialog: own personal file; own team file; someone else's team file (no Share, Copy link only); admin on a team
  file; switch off (member: no Share; admin: Share); adding a guest (not offered); a group; someone who already has
  access (grey line); remove access; a file moved into the trash while open.
- Copy link: each toast case; a folder (old link).
- Link page: opener with access by folder rules; grantee; group grantee; removed grantee (next request); no access
  (Ask); pending; declined then asks again; 24 h notice cap; 21st request in an hour; nonexistent id (same page, same
  timing); trashed file (owner: trash line; others: plain page); purged; guest; signed out; disabled owner.
- Owner notice: approve, decline, the file deleted meanwhile (buttons disabled, "This file is no longer there"),
  owner-less team file (owner/admins get it); push tap.
- Recipient: shared notice and push; Shared with me list, empty state, after removal (row gone).
- Rename and move by the owner and by another editor: link still opens; Shared with me shows the new name.
- AI: own chat (card, Always allow), shared chat named by sender (card to sender only), shared chat named only by
  another member (refused), several matching names, folder refused, view-only file refused, scheduled run refused;
  `share_file` link for someone without access gives the request page.
- Desktop: `/f/` opens in the app window. Phone (P2): universal link opens the app at the file.
- Admin: audit rows and their redaction; switch off; Remove all.

## DECISIONS.md changes (in the build PR)

- New section "A member shares their own files (TC-3093)" with the decisions above.
- Amend #787 "Deliberate differences from Drive" (around line 26651): "members do not share" becomes "members do not
  share **folders**; a member shares a file they own with chosen people (TC-3093)"; "no Copy link (no per-folder link)"
  stays for folders, and file Copy link is now the `/f/<id>` link.
- Amend the personal-folder rule ("`users/<id>/` is private to its person, admins too"): except a file its person
  shared, which opens by its link for the people they chose (no listing, no path).
- Amend `share_file`'s entry (the "checked again with their own access" line is kept, plus "gives nobody access").
- Note in "post_to_room" that `share_with_person` is offered in shared chats with the guards above.
- Nothing removed from the guest decisions (one place stays).

## Security risks

- **Path tricks.** The dialog and the tool take paths through `authorize()`; `..`, absolute paths, `.system/`, temp
  names and symlinks are refused as today. The id endpoints never take a path. A share row's path is written only by
  the server.
- **Links to folders.** Refused in the dialog, the tool and `PUT /api/files/shares` (`isDirectory()`), and `canOpen`
  answers no-access if a path became a folder.
- **Sharing a file you only view.** Refused (edit access now, plus owner by decision 1). Re-checked on every open: an
  owner who lost access stops sharing.
- **Id enumeration.** 128 random bits; one answer and one timing for every non-open case; requests on unknown ids
  answer "sent" and store nothing; request rate limit per person.
- **Request spam.** One pending per person per file, 20 per hour, one notice per person per file per 24 hours, notes
  capped at 500 characters and shown as plain text.
- **Prompt injection in shared chats.** The sender-named check and the sender-only card above; files the sender did not
  bring into this turn are refused.
- **Leaks through the recipient.** A grantee gets one file's bytes, never its folder, path or siblings; their AI cannot
  reach it in P1. A downloaded copy cannot be taken back; the dialog does not promise it can.
- **Admin overreach.** Admins do not gain access to personal files through the share tables; the audit names them
  "a personal file".
- A security review of the id endpoints and `canOpen` before merging P1 (one test per leak path in
  `tests/security/file-shares.test.ts`).

## Phasing

- **P1 (fixes the case):** migration 354; `files/shares.ts` (`canOpen`, `creatorOf`, move/trash hooks); id endpoints
  with rate limits; `/f/<id>` page with the request page; Activity notice with Share / Decline and push; the file
  Share dialog (after TC-3092's shared parts land, or with them if they are not merged yet); Copy link; Shared with
  me; `share_with_person` and the new `share_file`; audit; team switch and Remove all; desktop page path; docs and the
  `changes/file-share-links.md` fragment; QA rows to Pass.
- **P2:** Admin's "Files shared one by one" list; phone universal links (store build); guests in a shared place;
  the recipient's AI reading shared files (`shared:<id>` in the read tools).
- **Later, if asked:** Editor, several files in one link, "Remove from my list", email.

## Steps (P1)

1. Migration 354 and `files/shares.ts` with unit tests (move, trash, restore, purge, group membership, owner loses
   access).
2. Endpoints, rate limits, notices, push deliveries; `tests/security/file-shares.test.ts`.
3. Web: `FileLink.tsx`, Share dialog, Copy link, Shared with me, Activity row; mock server; i18n (en first).
4. AI tool, `share_file`, prompt line, always-allow kind; `b-chat` style tests for shared chats.
5. Desktop path; Admin switch and Remove all; audit.
6. DECISIONS, docs/site, changes fragment; QA sheet rows; screenshots at 1440/390 light/dark for every surface.

## Risks

- Migration number 354 may be taken by another branch first: re-check `server/migrations/` on dev before merge.
- `creatorOf` depends on `file_events` history; old files have none and are then not "owned" (only owner/admins share
  them). Said in the dialog's absence (no Share item), not as an error.
- TC-3092's shared parts may land after this; the file dialog then builds on the chat dialog's current parts and moves
  to `ShareWarning` when it is merged.
- Phone users clicking `/f/` before the P2 store build open the browser (works, one more sign-in at most).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:unit` (files, notifications, chat
tools), `tests/security/file-shares.test.ts`, the web e2e for Files, the link page and Activity (shared UI, so the
full web e2e before merge), under Bun 1.3.12 for the server tests.

## Result

Filled in at the end.
