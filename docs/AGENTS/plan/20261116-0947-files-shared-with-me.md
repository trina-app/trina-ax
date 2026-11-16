# File sharing P2: Files › Shared with me (PR 1), then guests, translated docs and push gaps

- Date (UTC): 2026-11-16 09:47
- Branch: `feat/files-shared-with-me` (PR 1 of P2; QA TC-3093 "P2")
- Status: in progress
- Where: Team AX core (`server/src/files/`, `shared/src/api/file-shares.ts`, web Files). Why: file sharing is core
  (docs/REPOSITORY-RULES.md: files and permissions go into the core first).
- Version impact: **minor** (a list, one endpoint, one realtime notice code; no migration in PR 1).

Follows: the archive's "A member shares their own files" (#979, its **P2** list),
[`docs/decisions/20261116-file-share-everyone.md`](../../decisions/20261116-file-share-everyone.md) (#1038, its "Not done"
list), plan `docs/AGENTS/plan/20261115-1407-file-share-links.md` ("P2 UI", guest option 6). This plan was reviewed
independently before building; the review's changes are merged in below (marked "review").

## What is on dev today (read in the code)

| Piece | Where | Note for P2 |
|---|---|---|
| Link row per file | `file_shares` (355): `path`, pins, `owner_id`, `state live/trashed/dead` | the list reads `path` for the name |
| Grants | `file_share_grants` (355), `subject_type user/group`, `granted_by`, `granted_at` | **indexed by recipient** already: `file_share_grants_subject (subject_type, subject_id)` |
| Everyone on the team | a group grant with id `*` | the same index answers `('group','*')` |
| Opening | `FileShares.open()` | rules first, then a grant while the owner can still edit; guest → no_access. **Writes**: `same()` may repin or mark the row dead (and hashes up to 32 MB) |
| Batches | `file_share_batches`, `_items` (356) | `file_share_batch_items_share` index |
| Activity | `file_share_notices` | opening a file does not mark its notice read today |
| Guests | every file-share endpoint is outside `auth/guest-endpoints.ts` → 403 at the route; the service refuses too | a guest has no Files tab (`NotForGuests`) |

## Goal

1. Someone who was given files finds them again without digging through Activity: **Files › Shared with me**.
2. Opening a file from there (or from anywhere) marks its Activity row read.
3. Later PRs: the "Share a file" docs in every language, a written guest rule (with one greyed row), phone push for
   access requests with a Settings switch, iPhone names and `/f/` app links.

## Scope

**In (PR 1):** the list (server, API, web page, sidebar row), the live update, the way back on the link page, one
`sharerFor()` for the list and the link page, mark-read on open, the en docs paragraph, the decision file, tests.
**Out (later PRs):** translated docs (PR 2), the greyed guest row (PR 3), the push gaps (PR 4: migration 358, the
switch, the access-request push, gateway text), store-build items (PR 5). No migration in PR 1.

---

## 1. Shared with me

### Where it sits

One row **Shared with me** directly under **Recent files** in Files' top list (icon `Users`, the shared `ListRow`).
Always there for members, owners and admins, also when the list is empty (people learn where shared files go before
they get one). Route: `/files?view=shared` (a query, like `?view=recent`; no new route). On a phone the same row is in
the Files tab's places (`FilesPlaces`), and the page has the phone bar with ‹ back to Files (as `RecentFiles`).

### What is in it

A file is listed when **all** hold for the caller now:

- a grant reaches them: by name (`user`, their id), a group they are in (`Principal.groups`, bound as an `IN` list), or
  `*` (the caller is an active non-guest: a guest never reaches the list);
- the share is `live`, its owner (when known) can still edit it (`ownerStillEdits`), and the file is still at its
  path as a regular file whose pin is not plainly broken (`pinState` ≠ `dead`, see Performance);
- they are not the file's owner (`owner_id ≠ me`);
- **a file I can already open through folder access:** a grant **by name** always lists it (someone pointed it at me
  on purpose). A grant only **through a group or Everyone** lists it only when the folder rules do **not** already let
  me read it. Group and Everyone rows then match what Activity told me about; a by-name share is always listed, even
  when Activity said nothing (`change()` tells only new openers) (review F11). If an admin narrows a folder and keeps
  its links, a file shared with Everyone there **appears** for the people who lost folder read: that grant is now their
  only way in (review F12).

Each row: a file icon by type, the file name (basename of the current path, `plainLabel`, 200), and one meta line
**"Mina · Nov 15"** (who shared it, when; the year when it is not this year, shared `formatDate`). Who and when come
from **`sharerFor()`**: the newest grant that **qualifies the row** (a by-name grant when the folder lets me read the
file, else the newest grant that reaches me). The same helper names the sharer on the link page (review F5). A granter
whose account is gone: "A former member". No path, folder, owner or group name (a grantee never learns where the file
lives).

A row opens **`/f/<linkId>`** (the existing link page) with `state.from = '/files?view=shared'`; the link page then
shows **"‹ Shared with me"** (desktop: a quiet link above the title; phone: the phone bar). Opened from Slack or
Activity, nothing new shows (review F8).

Sort: newest qualifying-reach first (`MAX(granted_at)` of the grants that reach me, then the share id). No sort menu.

### Performance (no walk over users, no hash, no write on the list)

- **No new index or table.** The query is a `UNION ALL` of three lookups on `file_share_grants_subject`:
  `('user', me)`, `('group', IN Principal.groups)`, `('group', '*')`, then `GROUP BY share_id` with
  `MAX(granted_at)` and `MAX(granted_at)` of the by-name grants, joined to `file_shares` (`state = 'live'`,
  `owner_id` not me), ordered `(sharedAt DESC, shareId DESC)` after the cursor. The `GROUP BY` aggregates all the
  caller's reaching grants on every page before `LIMIT`; fine for thousands of rows (review F6).
- **Split of `open()` (review F1):**
  - `pinState(s, st): 'same' | 'dead' | 'needs_hash'`: pure (the inode, size, mtime and ctime tests; a size change or
    no sha / over 32 MB → dead; else needs a hash).
  - `grantOpens(me, rules, s, segs, reach, ownerMemo): 'rules' | 'grant' | null`: pure; used by `open()` and the list.
  - `resolve(rel, rules, memo)` takes the rules it is given (loaded once per request).
  - `open()` keeps its side effects (hash on `needs_hash`, then repin or mark dead). **The list never calls `open()`,
    `same()`, `sha256File`, `markDead` or `repin`**: it treats `same` and `needs_hash` as listed, `dead` as not.
    A `needs_hash` row whose hash fails then answers "You need access" on click; nothing new leaks (the row already
    carries that basename).
- **Filter order per row**, cheapest first: `owner_id ≠ me` (SQL) → the folder-readable rule (`rules.access`, memory)
  → `ownerStillEdits` (memoised principals) → `resolve` + `lstat` + `pinState`.
- **Caps per call:** 2,000 SQL rows, 100 `lstat` calls, 50 listed (`limit` 1–50). `next` is the key of the **last row
  read** (on the lstat cap: the last row fully read; on 50 matches: the 50th). Nothing is skipped or repeated within one
  pass; a row whose key rises meanwhile (a new grant) moves above the cursor, and the same change reloads the page from
  the top (realtime below).
- The client handles **"0 rows, `next` set"** (many hidden team-wide shares): it reads the next page by itself, at most
  10 chained calls per open, and shows the empty line only once `next` is null.
- Never `openers()` / `grantees()` (both walk every account) on this path.

### API

`GET /api/files/shared-with-me?cursor=&limit=` (owner C, `auth: 'user'`), in `shared/src/api/file-shares.ts`:

```
SharedWithMe = { items: SharedWithMeItem[], next: string | null }
SharedWithMeItem = { linkId: string, name: string, sharedBy: string | null /* null = a former member */, sharedAt: string }
```

- No `size`, `mime`, `avatarVersion` or `sharedBy.id` (review F10): the row never shows them, and a recorded size can
  be stale.
- `limit` 1–50 (default 50), `cursor` opaque (base64url of `sharedAt|shareId`, validated: a time and a link id only);
  a bad cursor is 400 `validation`.
- Guests: not in `guest-endpoints.ts`, so **403** at the route (deny by default).
- `docs/features.ts`: `{ id: 'files.shared-with-me', name: 'Files shared with me', area: 'Files', endpoints:
  ['sharedWithMe'] }`. No new screen (`/files` belongs to `files.browse`).
- `SharedFileView` (the link page) gains `formerSharer?: true`: a qualifying grant whose granter's account is gone.

### Permissions

No new permission path. The list is "the grants that reach me + `grantOpens` + `pinState`", the same helpers `open()`
uses. Everything the caller cannot open is not in the list (nothing greyed, nothing counted). A stale row opens the link
page's existing `no_access` answer. `RuleSet.decide`, search and the AI's file tools are unchanged.

### Realtime (review F3, F4)

- One **content-free** notice `file_shares_changed` (no ids, paths, counts or people), **broadcast to every connected
  active non-guest member**, at most **once a second** per team, sent **after** the change is saved.
- The DB steps that change share rows (`sharesMoved`, `sharesTrashed`, `sharesRestored`, `sharesNarrowedByMove`,
  `removeLinksIn`, `sharesPurged`, `sharesForgotten`, `markDead`) only flag the team as changed (in memory, no I/O inside
  the transaction). The service (`FileShares`) sends the notice from a timer that runs after the synchronous
  transaction has returned. The service methods raise it themselves: `change` / `shareMany` / `removeAll` / `answer`,
  account removal's file-share cleanup, the folder save (`routes/admin.ts`, rules or "Remove those links too"), and both
  group-member saves (`admin/groups.ts` members, `admin/users.ts` a person's groups).
- Leak check: every member learns that some share somewhere changed at time T. Negligible: lists already reload on
  `files.changed`, and the event says nothing else. Guests never get it.
- Web: `store/live.ts` → `fileSharesChanged` emitter. The page reloads while mounted; otherwise the store marks the
  `shared` slot stale. Also reloads on `notificationsChanged`, `accessChanged`, `filesChanged`, `reloadAsked`, and on
  window focus / visibility when the last read is older than 30 s.

### Mark read on open (review F9; moved here from the push PR)

- **Only in `page()`** (GET `/api/files/shared/:id`), only when the answer is `open`. **Never in `open()`**: `open()`
  runs for every Inbox row (`noticeOut`), `batchFiles` and push `target()`, so marking there would mark the whole Inbox
  read as it is listed.
- Marks the caller's own `file.shared` notice of the share **and** every `b:<batch>` notice that holds it (opening one
  file of a press marks the press read; the list shows the rest). Then `notificationsOf(ctx).changed(me)` so the badge
  follows. A push still retrying stops (it is wanted only while unread).

### Search

Unchanged: search follows folder access only (P1 rule). The page has no search box.

### Account removal (review F2)

Nothing new to clean: the list is computed. `registerFileShareCleanup` deletes the shares of every file the deleted
person **owned**, team files they added included (`file_shares.owner_id`), and every grant naming them.
- **The sharer deleted, who owned the file** (Mina added `shared/plan.pdf` and shared it): the row is **gone** for the
  recipient.
- **The sharer deleted, who did not own it** (admin Ana shared Leo's `shared/q3.xlsx`): the row **stays**, "A former
  member · <date>".
- **The recipient deleted:** their by-name grants go; group grants never named them.

### States, every surface

| State | Desktop page (1440) | Phone (390) | Sidebar row |
|---|---|---|---|
| First load | `Skeleton lines={5}` as Recent files | same, under the phone bar | row shown at once (no count) |
| Later visit | last-read list at once (`store/fileLists` `shared` slot), read again behind it | same | — |
| Empty | "Files people share with you appear here." (`EmptyState`, no icon, no button) | same | — |
| 0 rows but more to read | keeps reading (at most 10 calls), skeleton; no empty line until `next` is null | same | — |
| Offline / read failed | `ErrorNote` with Retry; last-read rows stay under it | same | — |
| Server updating | the app-wide updating bar; last-read rows stay; reloads on `reloadAsked` | same | — |
| Lost access / trashed / dead / purged | row leaves on `file_shares_changed`; a stale click → "You need access" | same | — |
| Renamed or moved | row shows the new name | same | — |
| Sharer's account gone (not the owner) | "A former member · Nov 15" | same | — |
| Many rows | 50 a page, next page on scroll | same | — |
| Guest | no Files tab; `/files?view=shared` goes to their place; the endpoint 403 | same | — |

Light and dark: the tokens of `RecentFiles` / `FileBatch` (`ListRow scale="page"`); no new colours.

### Roles

Owner, admin, member: the same list, only what reaches them (an admin does not see other people's shares here). A
member while "Members can share files they own" is off: earlier shares stay listed. Guest: nothing.

### Lean UI: what is NOT added

No count or badge, no filter chips, no sort menu, no search box, no grid, no per-row ⋯ menu, no "Remove from Shared
with me", no "Shared by me", no path / owner / group column, no illustration, no first-run tip. Nothing is removed from
the Files column.

### Copy (English first)

| Key | en | ko |
|---|---|---|
| `filesPanel.shared` | Shared with me | 나에게 공유된 파일 |
| `filesPanel.sharedEmpty` | Files people share with you appear here. | 다른 사람이 공유한 파일이 여기에 나와요. |
| `filesPanel.sharedMeta` | {name} · {date} | {name} · {date} |
| `filesPanel.formerMember` | A former member | 이전 멤버 |
| `fileLink.backToShared` | Shared with me | 나에게 공유된 파일 |
| `fileLink.sharedByFormer` | Shared by a former member | 이전 멤버가 공유함 |

id, ja, es, zh get the same keys in the same PR.

---

## 2. Guests (PR 3 for the one UI line; the rule is written now)

Keep guests out of file links, both ways. A guest gets files by a post in their group chat or their project folder.
**What stays refused (unchanged code):** every file-share endpoint is **403 at the route** (not in
`guest-endpoints.ts`); the service also refuses (`linkFor`, `view`, `change`, `shareMany` → 404, `open()` → no_access,
`request()` → 403); `checkSubjects` refuses a guest recipient; `*` never reaches a guest; groups never hold guests.
PR 3 (lowest priority, after PRs 1, 2, 4; dropped if the owner finds the dialog busy): in the file Share dialog's people
search, a guest who shares a place with the caller (`sharesPlace`) shows greyed: "Guest · only sees files in their chat
or project." Not pickable.

## 3. Docs in every language (PR 2)

"Share a file" in es, id, ja, ko, zh (product words as each locale's `web/src/i18n/<l>.ts`), the "Files shared with
you" paragraph in all six (en lands in PR 1), `images/files/shared-with-me.webp` + zh picture, one guests.md line.
`check:docs` has no heading-parity check, so PR 2 can stay separate.

## 4. Phone push gaps (PR 4, PR 5)

- PR 4: migration **358** `notification_preferences.file_shares` (re-check the number before opening), Settings ›
  Notifications **"File sharing" / "파일 공유"** ("When someone shares a file with you by name or asks to open your
  file."), default on; `file.access_requested` pushes while pending and the receiver may answer; gateway text in six
  languages; `sw.js`. Never the file name or the note.
- PR 5 (store build): the iPhone extension names the sharer / requester; `/f/*` app links + the root Worker.

## Data model and migration

PR 1: none (`file_share_grants_subject` from 355). PR 4: 358 as above.

## Security review points (PR 1)

1. No path, folder or owner in `SharedWithMeItem`; name = `plainLabel(basename)`. Test: a grant-only row's JSON has no
   `/` and no `size`, `mime`, `avatarVersion`.
2. **Soundness:** every listed id passes `grantOpens(...) !== null` with `pinState ≠ dead`, and its `open()` answers
   `open` (except a `needs_hash` row whose hash fails). **Completeness:** every share where a grant qualifies,
   `pinState ≠ dead` and `owner ≠ me` is listed (review F7). A table drives both.
3. Guests: endpoint 403 (not in `guest-endpoints.ts`); `*` never reaches a guest.
4. Group subjects come from the server's `Principal.groups`, never the request; the cursor carries a time and a link id
   only and is validated.
5. No cost amplification: no hash, no write and no account walk on the GET; 2,000 SQL rows / 100 lstat caps;
   `RuleSet.load` once.
6. `file_shares_changed` is content-free, broadcast to all active non-guest members, coalesced (≤ 1/s).
7. Mark read on open: only in `page()`, never in `open()`, only the caller's own notices.

## Steps (PR 1)

1. This plan (first commit).
2. Server: `pinState` / `grantOpens` / `resolve(rules)` split, `sharerFor`, `sharedWithMe`, mark-read in `page()`,
   the coalesced broadcast and its call sites.
3. Shared: endpoint + schemas; `formerSharer` on the link page view.
4. Web: Files row, `pages/SharedFiles.tsx`, `store/fileLists` `shared` slot, `live.ts` emitter, FileLink way back,
   i18n in six languages.
5. Docs: `docs/features.ts`, en "Files shared with you" paragraph, `changes/files-shared-with-me.md`,
   `docs/decisions/20261116-files-shared-with-me.md`.
6. Tests: unit `tests/unit/c-file-shared-with-me.test.ts` (Bun 1.4 and 1.3.12), security
   `tests/security/file-shares-p2.test.ts` + the route's permission-matrix case, web e2e `files-shared-with-me.spec.ts`
   (owner, admin, member; 1440 and 390; light and dark; en and ko shots).

## Decisions

`docs/decisions/20261116-files-shared-with-me.md` (the list's rule, the broadcast, mark-read on open). Older:
the archive's "A member shares their own files"; `20261116-file-share-everyone.md`.

## Risks

Permissions (the list must never name a file the caller cannot open: soundness test), cost (caps), realtime noise
(coalesced broadcast), the five app languages, phone and desktop.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run features:check`, `docs:api`, the file-share
server tests under Bun 1.3.12, the full web unit suite, targeted e2e (the new spec, `file-share-links`,
`file-share-everyone`).

## QA rows (PR 1 only)

In the PR's QA list (one case per row): the list (named, group, Everyone hidden/listed, own file, order, paging, empty,
offline, updating, skeleton), live leave/return (✕, trash, restore, rename, folder narrowed, group removal, Remove
all), account removal (owner sharer gone / non-owner sharer "A former member"), the way back (1440, 390, not from
Activity), mark read (single file, a press), guests (no tab, 403), roles (owner, admin, member), ko copy, dark and 390.

## Open questions, answered

1. Folder-readable files shared with a group or Everyone: **hidden**; by name: **listed**.
2. Guests receive file links: **No**.
3. Push for access requests: **Yes** (PR 4), switch "File sharing".
4. Search finds files shared by name: **Not now**.
5. "Remove from Shared with me": **Not now**.
6. Opening one file of a press marks the press read: **Yes**.

## Result

(filled in at the end)
