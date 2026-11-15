# A member shares their own file with chosen people, Drive style: a link that opens for them, "Ask for access" for others

- Date (UTC): 2026-11-15 14:07 (revised after the plan review, same day)
- Branch: `feat/file-share-links`
- Status: in review (P1 built; PR #979)
- QA: TC-3093
- Where: Team AX core (`server/src/team-files/`, a new `server/src/files/shares.ts`, `server/src/tools/index.ts`, a
  new `server/src/chat/share-with-person.ts`, `server/src/notifications/`, `server/src/admin/`,
  `server/migrations/`, `shared/src/api/files.ts`, `web/src/pages/` (Files, a new `FileLink.tsx`),
  `web/src/components/` (the Share dialog parts), `web/src/i18n/*`, `desktop/src/common/address.ts`,
  `docs/DECISIONS.md`, `docs/site/`; P2: `push-gateway/`, `mobile/`, `shared/src/app-links.ts`). Why: files,
  permissions and sharing are core (docs/REPOSITORY-RULES.md).
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
link never shares more than they may see", which the AI read as "sharing". The teammate opened it and got "The file
can't be found, or you don't have access to it." A computer upload in a shared chat lands in the project folder, so the
photos were most likely a **team-folder** file the member added, not a personal one. A personal-folder-only first
release would not fix the case; P1 covers both. (TC-3091 fixes the other half: `post_to_room` in shared chats, which
can send copies.)

**Non-developer check:** "Share "photo.jpg" with Jun · Can view". "You need access · Ask for access". "Jun asked to
open "photo.jpg" · Share · Decline". Each reads in three seconds and matches what Drive users already know.

## Decisions taken in this plan (each with why)

1. **What "own" means.** No file has an owner today (no files table, no owner column; checked). A person may share a
   file when they can **edit** it now and either it is under their personal folder `users/<me>/`, or `creatorOf(path)`
   (new, `files/shares.ts`) is them. `creatorOf` **walks back from the current path**:
   - Start at the path. Take the **newest** `create` / `upload` / `restore` event at that path that has no later
     `delete` or move-away (`delete` with `movedTo`) at the same path. Older events at a reused path are ignored.
   - A `create` with `movedFrom` (the move's own event, `team-files/service.ts:830`) is **not** an authorship: follow
     `movedFrom` to the source path and continue the walk there (as of the move's time). So a move never makes the
     mover the owner, an admin's move included.
   - A `restore` (`service.ts:2110`, `detail.originalPath`): follow `originalPath` and continue there as of the
     delete's time.
   - A `create` with `copiedFrom` belongs to the **copier** (a copy is a new file).
   - Plain `create` / `upload`: that event's `user_id` is the owner. No event found (an old file, a file made on the
     disk outside the app): no owner.
   `owner_id` on the share row is set from this walk when the row is made and **never** from `created_by` (a viewer
   pressing Copy link must not become the owner). An owner-less team file can still get a link; its requests go to the
   team owner and admins. Owners and admins may share any team file (they already change folder access); they never
   reach another person's personal folder this way (`users/<id>/` stays private to its person, admins too).
   Tests: a reused path (old author ignored), a restore, someone else's move, a copy, an admin's move, a file with no
   events.
2. **Folders are not shared this way.** File grants are on files only. Folders keep #787's Share dialog (owner and
   admins). Why: a folder grant is a folder rule; #787 decided who writes those.
3. **View only for now.** Open, the preview and download of the current bytes only; no edit, no re-share. Why: an edit
   would write versions into someone's personal folder history and needs conflict and history rules of its own; Drive's
   default is Viewer too. The column has a CHECK list, so Editor needs only a new migration later.
4. **The link is an id, not a path: `/f/<id>`.** `id` = 16 random bytes, base64url (22 characters), made once per file
   on the first Share or Copy link, stable through renames and moves. Why: a path link breaks on rename and shows the
   folder names (`users/<id>/…/…`) to anyone it is forwarded to.
5. **The request page never shows the file name, its owner or its type.** Why: links get forwarded (into rooms, out of
   the team) and a file name can itself be the secret ("resignation letter.pdf"); Drive does the same. Ids are 128
   random bits, so they are not guessed; no fake "sent" for unknown ids and no same-timing promise (dropped in review:
   cost without a real attack). An unknown id gets the same page with the Ask button refused ("This link doesn't work.
   Ask the person who sent it."). After the owner shares, the notice names the file (they chose to).
6. **Guests: no in P1.** The picker leaves guests out, the server refuses them, and a guest who opens a `/f/` link gets
   "You can't open this file. Ask the person who sent the link." without Ask (a guest may not ping members of places
   they are not in). Why: a guest reaches exactly one room or project (owner, 2026-11-14); a file share would be a second
   place, and the guest P1 is deny-by-default with one test per leak path. P2 (optional): a guest who is already in a
   room or project the sharer is in (`auth/guests.ts sharesPlace`), with a "Guest" tag and one warning line.
7. **No "General access" for files.** A file link is always Restricted: people who can open the file by folder rules,
   plus the people and groups added. "Anyone in the team" stays a folder thing. Why: lean, and no second way to open a
   folder's content to everyone.
8. **A grant adds one file and never widens past what its owner chose.** Someone given a team file sees that one file,
   not the folder (no listing, no path, no siblings). When the file later moves somewhere with a **narrower** audience
   (`checkMove`'s `narrowed`, `service.ts:479-483`, the `audienceNarrowed` detail at :830) and the mover is **not** the
   owner, the grants are removed in the move's transaction, an audit row `file.unshare` (`reason: 'moved_narrower'`) is
   written and the owner gets a notice ("photo.jpg was moved by Mina, so the people you shared it with can no longer
   open it."). When the **owner** moves it, the existing move confirm adds one line: "N people have this file by its
   link." and the grants stay (their choice).
9. **The share is pinned to the file's content identity.** Like `team_file_refs` (`310_c_team_file_refs.sql`): the row
   keeps `ino`, `dev` and `sha256`, updated by every in-app save, upload over it, move and restore. Opening by id
   checks that the file at the path still matches (inode, or the last recorded sha256 when an atomic save changed the
   inode through the app); no match = no access. A different file put at the same path on the disk outside the app
   therefore never inherits the grants.
10. **A team switch** (Admin › Team settings, "Members can share files they own", **default on**, the owner's
    "switches default on") lets admins turn it off. Off: no Share for members, no new grants by members, and **no new
    access requests to members** (owner-less team files still reach owner and admins); existing grants keep working
    until removed.
11. **The AI's shared-chat rules are post_to_room's.** One rule set with TC-3091 (below, "AI").

## Scope

In (P1, the MVP): the data model and migration; the `/f/<id>` link and its endpoints; the request page; the request
notice with Share / Decline in **Activity**; the file Share dialog; Copy link for files; `share_with_person` and a true
`share_file`; audit rows; the team switch with "Remove all file shares"; desktop opens `/f/` in the app window; six
languages, English first.

Out (P2): push for the new kinds (deliveries tables, gateway codes, iPhone extension words, the Settings ›
Notifications switch); the "Shared with me" list in Files; Admin's list of every file share with per-row Remove; phone
universal links for `/f/*` (store build); guests in a shared place; the recipient's AI reading a file shared with them.
Later, if asked: Editor, several files in one link, "Remove from my list", email (the server sends no email today).

## Data model

Migration **`354_c_file_shares.sql`** (component C owns files: `301_c_files.sql`, `file_versions`, `trash_items`;
C's range is 300–399, its highest on dev is 353; re-checked 2026-11-15 after the review: no branch on the remote has
354–359. Check again before merge per docs/WORKPLAN.md §4). Additive only, `-- min_compatible_reader: 1`, explicit
columns, FKs `ON DELETE CASCADE`.

```sql
CREATE TABLE file_shares (            -- one row per shared or linked file
  id TEXT PRIMARY KEY,                -- the link id (22 chars, random)
  path TEXT NOT NULL,                 -- current path, rewritten by moves like file_versions.path
  ino INTEGER, dev INTEGER, sha256 TEXT,  -- the file's identity (decision 9)
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,  -- from creatorOf; NULL: no known owner
  state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','trashed')),
  trash_id TEXT,                      -- trash_items row while trashed
  created_by TEXT NOT NULL, created_at TEXT NOT NULL   -- who made the link (never the owner by itself)
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
  owner_id TEXT,                      -- who it went to (the pair cap counts by it)
  message TEXT,                       -- at most 500 characters
  state TEXT NOT NULL CHECK(state IN ('pending','approved','declined','closed')),
  created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT
);
CREATE UNIQUE INDEX file_access_requests_one_pending ON file_access_requests(share_id, requester_id) WHERE state = 'pending';
CREATE INDEX file_access_requests_pair ON file_access_requests(requester_id, owner_id, created_at);
-- file_share_notices: event_type IN ('file.shared','file.access_requested','file.access_answered','file.unshared_by_move'),
-- the same columns and indexes as service_request_closed_notices (353). Activity only in P1 (no push table).
```

- **Rename and move.** `TeamFiles.move` (`team-files/service.ts:769-840`) rewrites `file_shares.path` (and `ino`/`dev`
  after the rename) in the same transaction as `file_versions.path` (exact match for a file, prefix for a folder move),
  then applies decision 8. Copy makes a new file: no share follows it.
- **Trash.** `TeamFiles.remove` sets `state='trashed'` and `trash_id` (grants kept). The owner's link says "This file is
  in the trash" with Restore if they may; everyone else gets the no-access page. Restore sets `live`, the new path and
  identity. Purge (`purgeTrash`) and `forgetRecordsUnder` delete the share row; grants, requests and notices go with
  it.
- **Overwrite through the app** (save, upload over it): the same file, a new version (Drive's idea); the share stays and
  its `sha256`/`ino` are updated. Delete, then a new file at the same name: the old row is trashed or gone, so the new
  file starts unshared.
- **People and groups.** Group grants are read live (a person who leaves the group loses the file). A disabled or
  deleted account reaches nothing; a deleted owner's personal files go with them (CASCADE).
- **Who may open (`FileShares.canOpen(share, principal)`)**: the share is live and its identity matches (decision 9),
  and either the normal permission function gives read (`RuleSet.access`, unchanged) or a grant names them or one of
  their groups; they are not a guest (P1); and the owner (when there is one) can still edit the file (an owner who lost
  access stops sharing it). `RuleSet.decide` is **not** changed: grants are checked only on the id endpoints, so #787's
  permission function, its tests and `tests/security/folder-sharing.test.ts` stay as they are.

## Link and endpoints

- `/f/<id>` (web route, signed in; signed-out goes to sign-in and back). `GET /api/files/shared/:id` answers
  `{ status: 'open', name, size, kind, sharedBy? }` or `{ status: 'no_access', canAsk, askedAt? }`, or
  `{ status: 'unknown' }` for an id that does not exist (the page looks the same, without Ask).
- **The id endpoints serve only the current bytes:** `/api/files/shared/:id/{preview,download}`. No versions, no
  history, no extracted text, no path, no folder, no neighbours. Search, the AI's read tools and the per-folder
  file-list agent stay on `RuleSet` unchanged, so a grant never shows a file there. The preview reuses `FileBody` with an
  id source.
- `POST /api/files/shared/:id/request { message? }`; `POST /api/files/shared/:id/requests/:rid/{approve,decline}` (the
  owner, or owner/admins for an owner-less team file); `PUT /api/files/shares { path, add[], remove[] }` from the
  dialog. Every content request re-checks `canOpen` (a removed person loses it on the next request).
- **Rate limits.** Requests: one pending per person per file (a second press says "You already asked"); **5 per day per
  (requester, owner) pair** and 20 per hour per requester team-wide (`auth/rate-limit.ts RateLimiter`, DB-backed);
  after a decline they may ask again within those caps; one Activity row per person per file (re-armed, not
  duplicated). Pending requests close after the inbox's 30 days (`closed`). Grants from the dialog and the AI take from
  the room sending budget (`takeSendToken`), as chat sharing does.

## UI (lean: say what goes, reuse shared parts)

Every list and row uses the shared `ListRow` / `ListSection` / `ListIcon` and type tokens; no new px sizes.

1. **Share dialog for a file** (Files row ⋯ "Share", the preview panel's ⋯, the phone bottom sheet). Shown only to
   people who may share that file; others see Copy link only. Built from the chat Share dialog's parts and the
   one-press design planned for TC-3092 (`feat/share-dialog-one-press`, plan `20261115-1400-share-dialog-one-press.md`):
   the people and groups field with faces (`ProjectParticipants` picker; a member is offered only their own groups),
   the inline `ShareWarning` line while picking, and **one press** (Share saves; no "Share anyway"). Contents, nothing
   more:
   - Title: `Share "photo.jpg"`.
   - Field: "Add people or groups".
   - "People with access": the owner row ("Owner"), then each person or group with "Can view" and Remove access. A
     team file adds one grey line "People who can open the folder can open this file too" (no list of them).
   - One grey line from `ShareWarning` only when true: "Jun can already open this file", "Only this file: they won't
     see the rest of the folder".
   - Footer: Copy link (secondary), Share / Done (primary).
   Not added: General access, Notify toggle, roles menu (only one role), message box.
2. **Copy link** for files (Files row ⋯ `file-copy-link`, the preview panel, the image viewer, chat attachment menu)
   gives `/f/<id>` (made on first use; making it never sets an owner). Toast, true for each case: "Link copied. People
   with access can open it." On one's own unshared personal file: "Link copied. Only you can open it until you share
   it." with **Share…**. Folders keep their current link (no request flow for folders).
3. **The link page** (`web/src/pages/FileLink.tsx`): with access, the file preview plus "Shared by Mina" for a
   grantee. Without: an icon, "You need access", "Ask for access, or sign in with an account that has it.", an optional
   note ("Add a note (optional)"), [Ask for access]. After: "Request sent. You'll see the answer in Activity." Back
   while pending: "You asked on Nov 15. Waiting for an answer." Switch off and the file a member's: "You can't ask for
   access to this file. Ask the person who sent the link." Guest and unknown id: the same line, no button. Built like
   the chat 404 page (`pages/Chat.tsx:460-495`), a centered card, full width at 390.
4. **The owner's notice** in Activity (`file.access_requested`, in the Requests chip for everyone who gets one, not only
   admins): "Jun asked to open "photo.jpg"", their note quoted as plain text, inline **Share** and **Decline** (the
   `HandoverNoticeExtras` pattern, `components/handover/HandoverNotice.tsx:63`). After: "You shared it with Jun" /
   "Declined". The file gone meanwhile: buttons off, "This file is no longer there".
5. **The recipient's notices** (Activity): `file.shared` "Mina shared "photo.jpg" with you" (Open);
   `file.access_answered` on a decline: "Your request to open a file wasn't approved." (no name). An approve sends
   `file.shared`.
6. **The owner's own row** in Files gets the existing "shared" people glyph when a file has grants (no new chip).
7. **Admin › Team settings**: "Members can share files they own" (on) and, for the team owner, **Remove all file
   shares** (confirm: "Remove access for N people to M files? Links stop working for them at once.").

P2 UI: **Shared with me** (one row in the Files side column / a section in the phone Files tab, a flat list newest
first, "Mina · Nov 15", empty state "Files people share with you appear here."); Admin › Folder permissions "Files
shared one by one" (owner, shared with, file name or "Personal file", date, Remove).

## AI

- **`share_with_person(paths: string[] (1-10), people: string[], note?)`** in a new `server/src/chat/share-with-person.ts`.
  It acts as the turn's person ("A turn is its sender's": `livePrincipal()` on every call). People by
  `rooms/reader.ts findPeople` and groups by `project-members.ts matchName` (several matches: nothing is shared, the AI
  gets up to 10 `person:<id>` candidates to ask, as `post_to_room` does). Refused with why and what to do: a folder
  ("an admin shares folders in the folder's Share dialog"), a file the person does not own or only views ("only its
  owner can share it; send them the link so they can ask"), a guest, oneself, a disabled account, the switch off.
- **Card** (`ask_user`, `origin: 'server'`, shown only to the turn's person): `Share 2 files with Jun?`, the file
  names, "They'll be able to view them.", [Share] [Don't share]. `withAlways` with a new kind `file_share` in
  `CARD_ALWAYS_KINDS` (the owner's rule: the option is on the first card). On yes every check runs again and the plan's
  key must match (a changed group or owner: refused, "ask again").
- **Shared chats: the same rules as `post_to_room`.** TC-3091 (`fix/shared-chat-send-to-person`) offers
  `post_to_room` in shared chats with the actor = the person whose turn it is (the latest message's sender) and a card
  only they see, through one shared helper. `share_with_person` **reuses that helper** for who acts, where the card
  goes, which runs it is not offered in (scheduled run, template or restricted run, confidential chat, Slack,
  sub-agents) and how Always allow counts. It adds **one** file-specific check on top: in a chat someone else wrote in
  (`exec.shared` or `exec.otherAuthors`), each file must be one the turn's person attached, named in their own message,
  or the AI made in this turn; otherwise it is refused ("ask for it in your own message"). If the review of TC-3091
  adds a "recipient named in the asker's own words" rule, it goes into the shared helper and covers both tools; this
  plan adds none of its own.
- **After the share** the tool returns each `/f/<id>` link and the AI replies with them as Markdown links. In a shared
  chat everyone sees the reply; a link opens only for the people given access and those who already have it.
- **`share_file` becomes true.** Description: "Get a link the user can open or pass on. It gives nobody access: it
  opens only for people who can already open the file. To let a teammate open one of the user's own files, use
  share_with_person." For a file it returns the `/f/<id>` link (others then get the request page); folders keep the old
  link.
- Prompt: one sentence in the files rule when the tool is present ("share with a teammate" means `share_with_person`;
  say it is shared only when the result says so).

## Phone and desktop

- **Desktop (P1):** add `/f/:id` to `PAGE_PATH` (`desktop/src/common/address.ts:42`) so a `/f/` link clicked in the app
  or sent through `trina-ax://open?url=` opens in the app window.
- **Phone (P2, store build):** `APP_LINK_PATHS` gains `file: '/f/*'` (`shared/src/app-links.ts:25`), the AASA
  components and the Android `pathPrefix /f/` filter (`mobile/app.config.ts:79`); `readAppLink` maps `/f/<id>` to that
  entry path instead of `/` (`shared/src/team-link.ts:182-193, 336`; the mobile copy stays byte-identical); the
  trina.app root Worker's file is regenerated from `app-links.ts`. Until then the link opens in the phone's browser,
  which works.
- **Push (P2).** The two kinds get deliveries tables and gateway codes. The gateway's line is generic ("Someone shared a
  file with you." / "Someone asked to open a file."); the sharer's or requester's name comes from the signed-in label
  fetch (`POST /api/push/devices/:id/label`, the iPhone extension; the browser from the notice fetch), as for
  `chat.shared` (DECISIONS "Chats shared with me" push, around line 27880). **Never the file name in a push**, on any
  path. A Settings › Notifications switch comes with it.

## Audit, admin overview, emergency revoke

- Rows (`admin/audit.ts audit()`): `file.share` (actor, share id, `{ people: n, groups: n, via }`), `file.unshare`
  (`reason`: `removed` / `moved_narrower` / `removed_all`), `file.access_request` (never the note),
  `file.access_approved`, `file.access_declined`, `file.shares_removed_all` (team owner, counts). A personal file is
  named "a personal file" to admins (`redactPersonal`, as today); team files by path. Who received access is shown (a
  permission change).
- Team owner's emergency revoke (P1): the switch off stops new shares and new requests to members; **Remove all file
  shares** deletes every grant and pending request at once. Disabling an account ends its shares (the owner check in
  `canOpen`).
- P2: the admin list with per-row Remove and a per-person "Remove all shares by Mina".

## States (QA rows: one case per row, every surface)

For each: owner, admin, member, guest; 1440 and 390; light and dark; en first, then ko, id, ja, es, zh; and the words
true for that state.
- Share dialog: own personal file; own team file; someone else's team file (no Share, Copy link only); admin on a team
  file; switch off (member: no Share; admin: Share); adding a guest (not offered); a group; someone who already has
  access (grey line); remove access; the file moved to the trash while open.
- Copy link: each toast case; a folder (old link); a viewer's Copy link does not make them the owner.
- Link page: opener by folder rules; grantee; group grantee; removed grantee (next request); no access (Ask); pending;
  declined then asks again; the 6th request to one owner in a day; the 21st in an hour; switch off (no Ask for a
  member's file); unknown id; trashed (owner: trash line; others: plain page); purged; a different file at the same
  path on the disk (no access); guest; signed out; disabled owner.
- Owner's notice: Share, Decline, the file gone meanwhile, an owner-less team file (owner/admins get it).
- Recipient: shared notice; decline notice.
- Move: by the owner (confirm line, grants stay); by another editor into a narrower folder (grants removed, owner
  notice, audit); by an admin (owner unchanged); rename (link still opens).
- `creatorOf`: reused path, restore, someone else's move, copy, admin's move, no events.
- AI: own chat (card, Always allow); shared chat, the turn's person names the file (card to them only); shared chat,
  the file only in another member's message (refused); several matching names; folder refused; view-only file refused;
  scheduled run refused; `share_file` link for someone without access gives the request page.
- Id endpoints: no versions, history, text or path (security tests).
- Desktop: `/f/` opens in the app window. Admin: audit rows and their redaction; switch off; Remove all.

## DECISIONS.md changes (in the build PR)

- New section "A member shares their own files (TC-3093)" with the decisions above.
- Amend #787 "Deliberate differences from Drive" (around line 26651): "members do not share" becomes "members do not
  share **folders**; a member shares a file they own with chosen people (TC-3093)"; "no Copy link (no per-folder link)"
  stays for folders, and a file's Copy link is now the `/f/<id>` link.
- Amend the personal-folder rule ("`users/<id>/` is private to its person, admins too"): except a file its person
  shared, which opens by its link for the people they chose (current bytes only; no listing, no path).
- Amend `share_file`'s entry ("gives nobody access" added).
- `share_with_person` in shared chats: "the same as post_to_room" (TC-3091's section), plus the one file check.
- Nothing removed from the guest decisions (one place stays).

## Security risks

- **Path tricks.** The dialog and the tool take paths through `authorize()`; `..`, absolute paths, `.system/`, temp
  names and symlinks are refused as today. The id endpoints never take a path. A share row's path is written only by
  the server.
- **Links to folders.** Refused in the dialog, the tool and `PUT /api/files/shares` (`isDirectory()`); `canOpen` answers
  no-access if the path became a folder.
- **Sharing a file you only view.** Refused (edit access now plus owner by `creatorOf`). Re-checked on every open.
- **Owner spoofing.** A move, an admin's move or a Copy link never makes someone the owner (`creatorOf` rules, tests).
- **Widening by a move.** Decision 8; **path reuse on the disk**: decision 9.
- **Id enumeration.** 128 random bits; the page never shows name, owner or type; the request rate limits.
- **Request spam.** One pending per person per file, 5 per day per (requester, owner), 20 per hour, notes capped at 500
  characters and shown as plain text; switch off = no new requests to members.
- **Prompt injection in shared chats.** TC-3091's helper (the turn's person acts, card only to them) plus the file
  check.
- **Leaks through the recipient.** Current bytes only; no versions, history, extracted text, path or folder; search,
  AI read tools and the file-list agent stay on `RuleSet`. A downloaded copy cannot be taken back; nothing promises it.
- **Admin overreach.** Admins gain no access to personal files through the share tables; the audit says "a personal
  file".
- `tests/security/file-shares.test.ts`: one test per leak path (versions, history, text, path, search, read tools,
  file-list, folder, guest, moved narrower, path reuse, owner spoofing); a security review of the id endpoints and
  `canOpen` before merging P1.

## Phasing

- **P1 (the MVP that fixes the case):** migration 354; `files/shares.ts` (`canOpen`, `creatorOf`, the move / trash /
  identity hooks); the id endpoints with rate limits; the `/f/<id>` page with the request page; Activity notices with
  Share / Decline; the file Share dialog (on TC-3092's shared parts, or the chat dialog's current parts if they are not
  merged yet); Copy link; `share_with_person` (on TC-3091's helper) and the new `share_file`; audit; the team switch
  and Remove all; the desktop page path; docs and `changes/file-share-links.md`; QA rows to Pass.
- **P2:** push (tables, gateway codes, iPhone extension words, Settings switch); Shared with me; Admin's list; phone
  universal links; guests in a shared place; the recipient's AI reading shared files.

## Steps (P1, after TC-3091's helper is merged)

1. Migration 354 and `files/shares.ts` with unit tests (`creatorOf` cases, move, narrowed move, trash, restore, purge,
   identity, groups, owner loses access).
2. Endpoints, rate limits, notices; `tests/security/file-shares.test.ts`.
3. Web: `FileLink.tsx`, Share dialog, Copy link, Activity rows and buttons, the move confirm line; mock server; i18n
   (en first).
4. AI tool on TC-3091's helper, `share_file`, prompt line, the Always allow kind; shared-chat tests.
5. Desktop path; Admin switch and Remove all; audit.
6. DECISIONS, docs/site, changes fragment; QA rows; screenshots at 1440/390 light/dark for every surface.

## Risks

- Migration number 354 may be taken by another branch first: re-check `server/migrations/` on dev before merge.
- `creatorOf` depends on `file_events`; old files have none and then have no owner (only owner/admins share them; the
  member just sees no Share item).
- TC-3091's helper name and shape are fixed when it merges; this plan's AI step follows it.
- TC-3092's shared parts may land after this; the file dialog then starts on the chat dialog's current parts and moves
  to `ShareWarning` when it is merged.
- Without push in P1, the owner sees a request when they open Activity (the unseen marker shows it).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:unit` (files, notifications, chat
tools), `tests/security/file-shares.test.ts`, the web e2e for Files, the link page and Activity (shared UI, so the full
web e2e before merge), server tests under Bun 1.3.12.

## Result

P1 built on `feat/file-share-links` (PR #979). What differs from the plan and why:

- **Migration 355**, not 354: `feat/old-files-key-scan` took 354 first (`355_c_file_shares.sql`, C range, additive).
- **The shared helper** is `server/src/chat/shared-actions.ts` (TC-3091 merged as #980): `actionOff`, `mainOnly`,
  `askerPicks`, `namesRecipient` / `namedByAsker` (moved from post-to-room.ts, re-exported there), `namesFile`.
  post_to_room's behaviour is unchanged (its tests pass). share_with_person shows its card every time (no Always
  allow) and is never offered in a scheduled run; its paths are not reads for the shared chat's read card.
- **Link guard:** the api engine's link guard (engine/api-links.ts) now treats `/f/<id>` as a team link, so a link a tool
  gave survives and an invented one becomes plain text.
- **share_file** returns the `/f/<id>` link for a file's preview; folders and downloads keep the path link.
- **Deleted accounts:** their file-share notices, requests and grants go (`registerFileShareCleanup`).
- **Web:** Share shows on every file's ⋯ (the list does not know each file's owner; the dialog says why when the viewer
  cannot share). The TC-3092 `ShareWarning` is not merged yet, so the dialog has no warning line.
- Tests: `tests/unit/c-file-shares.test.ts`, `tests/security/file-shares.test.ts`, `tests/unit/b-share-with-person.test.ts`,
  `web/test/e2e/file-share-links.spec.ts` (screenshots of every surface at 1440/390, light and dark).
