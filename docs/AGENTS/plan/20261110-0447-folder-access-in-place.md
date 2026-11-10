# Who can see a folder, shown where the folder is

- Date (UTC): 2026-11-10 04:47
- Branch: `feat/folder-access-in-place`
- Status: draft (phase 1: plan and review only; nothing is built until the manager checks it)
- Where: Team AX core (`server/src/team-files/`, `server/src/routes/files.ts`, `shared/src/api/files.ts`,
  `web/src/pages/Files.tsx`, a new `web/src/components/FolderAccess*.tsx`, one change in
  `web/src/pages/admin/AccessTree.tsx`). Why: files and permissions are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. One new read endpoint and a new element on the Files page; no migration, no change to any
  existing answer.
- Depends on #298 (`feat/project-members-panel`, project members). This branch is rebased on dev after #298 lands,
  before any code.

## Goal

The owner (2026-11-10): "Folder permission management is too hard. I can't tell who has permission to what. To find
out I have to go into Admin › Folder permissions, and I'm not sure that's right. Same for projects."

Today the Files page says only what *I* can do (the "Read-only folder" badge, the lock on read-only rows). Who else
sees a folder is only in Admin › Folder permissions. After this change an admin sees on every folder of the Files page
how many people see it, and one click shows who, by name, with their access and where it comes from, with a way to
change it. A member sees, where they can put files, how many people will see them. A project folder says that its
access follows the project's members and links to #298's members dialog; nothing new is built for projects.

## References (official help pages; nothing logged in, so the screens themselves are not checked)

| Product | At the item | Inherited | Groups | Someone who cannot manage it |
|---|---|---|---|---|
| Google Drive | Details › Manage access: "People with access" plus "General access" [G1][G3] | sub-items inherit the folder's sharing; a limited folder lists "Access removed" for people a parent gives access to [G1][G3] | shared by group address [G1] | viewers cannot share [G1]; whether they see the list: unverified |
| Notion | the Share menu lists "the groups and individuals with access, and what level of access they have"; faces in the top bar [N1][N2] | a subpage takes its parent's permissions; "Everyone at {workspace}" line [N2] | one row per group; counts only in Settings › Groups [N1][N3] | "you'll see what level of permissions you currently have" [N2]; the full list: unverified |
| Dropbox | ⋮ › Manage permissions › People; faces by Share [D1][D2] | subfolders of a team folder inherit the parent's members, can be restricted and restored [D4] | a group is one row; members see other members only "for groups that they're already in" [D4][D7] | its pages disagree: only editors see the list [D1] vs viewers "view folder members" [D2]. Icons: people = shared, a slashed circle = restricted, a lock on a file = editing locked [D8] |
| Box | Sharing tab in the side bar, Manage Collaborators [B1] | access flows down and changes only where it was given [B2]; direct vs inherited only in the Admin Console [B3] | users and groups listed [B1] | sees the list by default; with "Hide collaborators … from non-owners" names become "Someone" [B1] |
| SharePoint / OneDrive | faces in the Share window open Manage access (People, Groups, Links); "Has access" in Details [M1][M2] | "This library inherits permissions from its parent", "unique permissions", a "Direct access" part [M3][M4] | a Groups tab; the people list shows "the number of people with access" [M5] | unverified |

Sources: [G1](https://support.google.com/drive/answer/7166529?hl=en&co=GENIE.Platform%3DDesktop),
[G3](https://support.google.com/drive/answer/14254362?hl=en&co=GENIE.Platform%3DDesktop),
[N1](https://www.notion.com/help/guides/grant-access-teamspaces), [N2](https://www.notion.com/help/sharing-and-permissions),
[N3](https://www.notion.com/help/create-and-manage-groups), [D1](https://help.dropbox.com/share/determine-owner),
[D2](https://help.dropbox.com/share/set-file-folder-permissions), [D4](https://help.dropbox.com/share/restrict-folder-access),
[D7](https://help.dropbox.com/account-access/groups), [D8](https://help.dropbox.com/organize/file-folder-symbol-icon),
[B1](https://support.box.com/hc/en-us/articles/360044196273-Managing-Collaborators),
[B2](https://support.box.com/hc/en-us/articles/360043697254-Understanding-Item-Permissions),
[B3](https://support.box.com/hc/en-us/articles/39122091946899-Managing-Collaborators-of-a-User-s-Files-and-Folders),
[M1](https://support.microsoft.com/en-us/sharepoint/sharepoint-sharing-and-permissions/see-who-a-file-is-shared-with-in-onedrive-or-sharepoint),
[M2](https://support.microsoft.com/en-us/onedrive/sharepoint/manage-sharing-and-permissions-in-onedrive-and-sharepoint),
[M3](https://support.microsoft.com/en-au/office/managing-file-access-in-onedrive-c6dabe03-fb3d-47cf-97af-38db44e5277c),
[M4](https://support.microsoft.com/en-us/sharepoint/lists/sharepoint-sharing-and-permissions/customize-permissions-for-a-sharepoint-list-or-library),
[M5](https://support.microsoft.com/en-us/sharepoint/libraries/share-documents-or-folders-in-sharepoint-server).
Unverified from the pages: a per-row "inherited" label (Drive, Notion, Dropbox), whether a group can be opened into
its people in the dialog (all five), what a SharePoint user who cannot manage access sees.

What we take: the answer sits on the item (all five); a group stays one row (Notion, Dropbox, SharePoint); inherited
access says where it comes from (SharePoint's "inherits permissions from its parent"); a non-owner can be shown no
names (Box's "Someone"), and other groups stay out of a member's sight (Dropbox: "only for groups that they're already
in"); a restricted folder does not reuse the lock, which means "editing locked" (Dropbox's icons). What we do not take:
the names list for everyone (Drive, Notion, Box by default). Showing members only a count is in none of the five: our
members have never seen names, roles or groups (below), and rules here are set by admins, not shared by each person.

## Decisions

### 1. What a member learns, what an admin sees

Options for a member:

| Option | New for a member | Verdict |
|---|---|---|
| A. Every name with access (Drive, Notion) | names and levels; who the admins are; who is in which group | No |
| B. Groups and a count ("Design · 6") | group names and where rules are; members see only their own groups (`GET /api/me`) | No |
| C. A count on every folder they can open | group sizes and rules above folders they can only pass through (review: `user:M read` on `groups/finance/public` counts the finance group); counts of empty read-only folders | No |
| D. A count only where they can write, plus their own folder and the project folders they see | nothing (below) | **Chosen** |

Why D says nothing new:

- Where the member can write, the count is already one request away: copying a file from their own folder there with
  `dryRun` answers `viewersAdded`, every active reader but them (`team-files/service.ts`). The endpoint returns
  that number plus one.
- A team project they see already carries `Project.audience` (every project in the list, read-only members included;
  `chat/shared.ts` `projectShare`). The chip there uses that number; no new request.
- Their own folder: "only you" is what PERMISSIONS.md already says.
- "Everyone" equals the count against the people directory's size (`/api/people`, the same active filter).
- On a folder they can only read, they get nothing new: the existing "Read-only folder" badge stays and no chip is
  shown. Counts there would be new (option C), and the plan's question "who sees what I put here" does not arise
  where they cannot put anything.
- The owner and admins are counted, never named ("Admins are never named", DECISIONS, review of #273). How many admins
  there are can already be had from `Project.audience` of a project with no other members (where members may make
  projects), or from the copy dry run into a folder only they and the admins read.
- Comparing counts (a folder against the one above it, or over time when someone is switched off) tells a member that
  a rule narrows a folder or that someone could open it. This is already true of the copy dry run and
  `Project.audience`, and D adds no folder to it. PERMISSIONS.md says so in plain words.

A member never gets: names, faces, group names (their own included: "you see it through Design" would say where an
admin put a rule), roles, how many can edit, which folder a rule is on, rules on folders inside, people switched off,
risk notes, and no count on a folder they can only read or pass through.

An admin sees what Admin › Folder permissions shows, from the same admin endpoints. Admins write everywhere outside
`users/`, so they get the chip on every folder.

### 2. The chip

A small ghost chip with a people icon at the end of the breadcrumb row, after the last crumb and before the existing
"Read-only folder" badge, on every width. Its accessible name is the panel's headline.

| Case | Who gets it | en | ko |
|---|---|---|---|
| `users/<me>` and anything in it (by path, no request) | everyone | Only you see it | 나만 봐요 |
| every active person can open it | where the caller can write | The whole team sees it | 팀 전체가 봐요 |
| no member can open it (the tree's `who` has no rule that lets a member in) | admins only | Owner and admins only (`accessTree.who.adminsOnly`) | 팀장과 관리자만 |
| the folder of a team project (any in `projectsByFolder` outside `users/`, legacy ones outside `projects/` too) | everyone who sees the project | `Project.audience` with #298's words (`projects.membersCount`) | N명이 봐요 |
| otherwise | where the caller can write | #298's `projects.membersCount` | N명이 봐요 |

- The number counts active people who can open the folder, the caller, the owner and admins included: the same
  number as `Project.audience` and Admin's "Can open".
- No chip: the team root; the top containers `users/`, `groups/`, `projects/`, `connected/` (each folder inside has its
  own rules, so a count of the container itself misleads); the trash view; a folder a member can only read or pass
  through; while rows are selected (the selection bar replaces the breadcrumbs); while loading or after a failed request
  (never a wrong number). `shared/` and `skills/` do get one.

### 3. The panel ("Who can see it")

The app's `Modal` (a bottom sheet below 640 px). Title "Who can see it", the folder in words under it
(`useFolderWords`: 전사 공유, 내 폴더 …).

Member, a folder they can write: the headline (#298's `projects.whoCount`, "N명이 봐요 (팀장·관리자 포함)", or "The
whole team sees it") and one line "An admin changes who can see it." Nothing else.

Own folder (everyone): "Only you see it" and "Admins can't open it either." No names and no button for anyone (rules
never apply there; the admin endpoints refuse `users/`).

A team project's folder (everyone who sees the project; legacy projects outside `projects/` too): the headline from
`Project.audience`, then "This is the folder of the project {name}. Who sees it follows the project's members." Then,
only with #298's fields and strings, never its files:

- `Project.membersEditable`: [Members] → `/projects/:id?members=1`, where #298 opens its dialog. The panel closes
  first.
- otherwise #298's own sentence, in the panel: `projects.membersByCreator` (with `creatorChangesMembers`) or
  `projects.membersByAdmins`; for an admin, `projects.legacyNote` (a folder outside `projects/`) or
  `projects.membersFolderMissing`, with the link to Admin. (`?members=1` opens nothing for them on #298's page, so the
  panel says it here.)

No folder rules editor replaces [Members] on a `projects/<name>` folder. An admin also gets the read-only admin part
below on every project folder (the people by name, where it comes from), so "same for projects" is answered in Files
too; on a legacy project folder an admin also keeps [Change] (PR 2).

Admin, any team folder (PR 1, read only):

- The headline: #298's `projects.whoCount` / "The whole team sees it" / "Owner and admins only".
- Where it comes from: `sourceText` from `GET /api/admin/access/tree?path=&limit=1` (`self.who`): "From shared",
  "This folder's rules", or per group of people when it differs. The tree row's own sentence.
- The people: AccessTree's `People`, as it is (moved into a shared component, AccessTree unchanged): the counts line
  ("Can open · Can write · Cannot open"), one list with face, name, role, the dim reason and the access in the
  `access.*` words, "Load more". Each name links to Admin's By person for that person.
- "{n} folders inside have their own rules", only when n > 0 (`GET /api/admin/access/tree?path=&rules=1&limit=1`,
  `total` minus the folder itself), linking to Admin with this folder chosen.
- #298's "See folder permissions" (`projects.otherRulesLink`) → `/admin/folders?folder=<path>`.

Admin, PR 2: [Change] → `/admin/folders?edit=<path>&from=files`. AccessTree opens its edit panel as it does for By
person; closing or saving it goes back to `/files?path=<path>&access=1`, which reopens this panel with fresh numbers.
`from=files` is a fixed word, never a URL (no open redirect); the way back is built with `encodeURIComponent(path)`;
`edit=` only chooses the folder (saving still takes a click and the rules hash check). `access=1` opens the panel only
where §2 shows the chip. Not on a team project folder in `projects/` (its [Members] does that) and not on a personal
folder.

### 4. Inherited access

- Members: not told which folder a rule is on. The count already includes access that comes from above.
- Admins: `sourceText` says it as Admin does. Access is decided per person, walking up to the first rule that names
  them, so the panel says "From shared" for everyone only when that is true, and by group of people otherwise.

### 5. Special folders

| Folder | Chip | Panel |
|---|---|---|
| Team root, `users/`, `groups/`, `projects/`, `connected/` | none | none (no ⋯ entry on those rows) |
| `users/<me>/…` | Only you see it | own-folder lines, for everyone |
| `shared/` and below | members where they write; admins always | member or admin panel |
| `skills/` and below | the same (members usually read only there: no chip, the badge) | admin: the people list shows the skill managers as "Read & write" |
| `groups/<g>/` and below | the same | member or admin panel |
| `projects/<name>/` of a team project | everyone who sees the project (`Project.audience`) | project line, [Members] or #298's sentence; admins also the people list; no rules editor |
| a legacy project's folder (outside `projects/`) | everyone who sees the project (`Project.audience`) | project line and #298's sentence (legacy note for admins); admins also the people list and [Change] |
| folders inside a project | members where they write; admins always | team folder panel (admin rules inside a project are changed in Admin) |
| `connected/<name>/` and below | members where they write (it is read-only for them); admins always | team folder panel |

### 6. No new lock icon

The manager's draft had a lock on rows not open to everyone. Not added: on the Files page the lock already means
"read only for you" (rows and badge), and a read-only restricted folder would carry one icon with two meanings.
Dropbox also keeps the lock for "editing locked". Admin's tree keeps its own lock as the overview of restricted
folders. Nothing else is added to rows either.

### 7. Entry points

1. The chip, for the folder on screen.
2. A folder row's ⋯ menu: "Who can see it", after "Open project", on the rows where the chip would show for that folder
   (§2). It opens the same panel without going in.

A member's folder shows one of: the chip, the "Read-only folder" badge or the pass-through badge. The one exception is
a read-only team project folder, which shows both the chip (`Project.audience`, as on the Projects page) and the badge.
3. Admin › Folder permissions stays the overview, unchanged; the panel links to it.
4. The project page stays as #298 makes it (its 멤버 row). No faces or count are added there.

### 8. Phones

- Files' phone layout (below 768 px): the breadcrumb row wraps as today; the chip keeps its place after the last crumb.
  The chip is 28 px high with a padded 44 px hit area.
- The panel is a bottom sheet below 640 px (the `Modal`), the title and close stay visible and the people list
  scrolls inside. [Members] and [Change] close the panel before they navigate, so no sheet opens over another.

### 9. The API

- **New: `GET /api/files/audience?path=`** (owner C, `auth: 'user'`).
  - Answer: `{ path, access }` for a folder the caller can read, plus `people` and `everyone` only when a real write
    would pass (`authorize(..., 'write')`, so not inside a plugin-managed folder, where the copy dry run fails too): the
    actual names on disk, the caller's access, the number of active people who can open it (caller,
    owner and admins included) and whether that is every active person. Never names, ids, groups, roles, writers or
    rule folders.
  - Errors: exactly what `GET /api/files/tree` answers for the same path, except that a folder the caller can only
    pass through answers the tree's 404 for a folder they cannot see. So a missing path, another person's folder
    (any case or Unicode form), `.system/` and a pass-through folder are one 404; temp and refused names are the
    tree's 400; a link or a look-alike name inside a readable folder is the tree's 409. Nothing the tree does not
    already tell.
  - One `RuleSet` for both the access check and the count; the count is `atLeast(rules.access(p, segs), 'read')`
    over `activePeople` (as `viewersAdded`), never built from the admin `whoAt` rows (they carry names).
  - Not in the AI's tools or the remote connector (its tool list is fixed).
- **Reused, unchanged, admin only:** `GET /api/admin/access/tree` (`self.who`, `rules=1`), `GET /api/admin/access/folder`
  (people). The web shows these parts only to admins; the server already refuses them to members.
- **Projects (#298, not changed):** `Project.audience`, `Project.membersEditable`, `/projects/:id?members=1`.
- **AccessTree (PR 2):** `?edit=<path>&from=files` (the word `files`, nothing else) goes back to the Files folder.

### 10. Copy (English first; all five languages)

| Key | en | ko | id | ja | es |
|---|---|---|---|---|---|
| `folderAccess.menu` (title and ⋯) | Who can see it | 볼 수 있는 사람 | Yang bisa melihat | 見られる人 | Quién puede verla |
| `folderAccess.onlyYou` | Only you see it | 나만 봐요 | Hanya Anda yang melihatnya | 自分だけが見られます | Solo tú la ves |
| `folderAccess.team` | The whole team sees it | 팀 전체가 봐요 | Seluruh tim melihatnya | チーム全員が見られます | Todo el equipo la ve |
| `folderAccess.ownFolder` | Admins can't open it either. | 관리자도 열 수 없어요. | Admin pun tidak bisa membukanya. | 管理者も開けません。 | Tampoco los administradores pueden abrirla. |
| `folderAccess.adminsChange` | An admin changes who can see it. | 볼 수 있는 사람은 관리자가 바꿔요. | Yang bisa melihatnya diubah oleh admin. | 見られる人は管理者が変更します。 | Quién puede verla lo cambia un administrador. |
| `folderAccess.project` | This is the folder of the project {name}. Who sees it follows the project's members. | '{name}' 프로젝트의 폴더예요. 볼 수 있는 사람은 프로젝트 멤버를 따라요. | Ini folder proyek {name}. Yang bisa melihatnya mengikuti anggota proyek. | プロジェクト「{name}」のフォルダーです。見られる人はプロジェクトのメンバーに従います。 | Es la carpeta del proyecto {name}. Quién puede verla sigue a los miembros del proyecto. |
| `folderAccess.below` (admin) | {n, plural, one {# folder inside has} other {# folders inside have}} their own rules | 안에 규칙을 따로 둔 폴더 {n}곳 | {n} folder di dalamnya punya aturan sendiri | 中に個別のルールがあるフォルダー {n}件 | {n, plural, one {# carpeta de dentro tiene} other {# carpetas de dentro tienen}} sus propias reglas |
| `folderAccess.change` (admin, PR 2) | Change | 바꾸기 | Ubah | 変更 | Cambiar |

Reused as they are: #298's `projects.membersCount` (chip), `projects.whoCount` (headline), `projects.participants`
("Members", the button), `projects.otherRulesLink`; `accessTree.who.adminsOnly`, `accessTree.counts`, `access.*`,
`files.openProject`, `common.close`, `common.loadMore`, `sourceText`'s sentences. Korean wording is checked against
the neighbouring strings when it is built.

## Not added, removed, unchanged

- Not added: a count for members on folders they can only read; names, faces or group names for members; a lock or
  any other mark on rows; a "request access" button; a panel for single files (a file follows its folder; later, from
  the file panel); anything on the project page or the project list; a second members flow or a copy of #298's
  dialog; the folder rules editor inside Files (PR 2 links to Admin's, with the way back); risk notes in the panel;
  an AI tool; a live count while the panel is open.
- Removed: nothing.
- Unchanged: Admin › Folder permissions (By folder, By person, the edit panel), the "Read-only folder" badge and the
  read-only row lock, every existing endpoint and answer, #298's members row, dialog and fields, and the AI tool of
  its follow-up PR (`feat/project-members-tool`).

## Scope

In: the endpoint, the chip, the panel (member and admin), the ⋯ entry, AccessTree's way back to Files, five
languages, docs.
Out: the file panel entry, the mobile app (it wraps the web app), the AI and the connector, the earlier leaks the
security review found (below; separate fixes).

## Steps (two PRs to `dev`)

1. **PR 1, `feat/folder-access-in-place`** (this branch, rebased on dev after #298):
   - this plan (first commit);
   - server: `TeamFiles.audience()`, the route, `shared/src/api/files.ts`, the mock server, `docs:api`;
   - web: the chip, the panel for members, own folder, project folders and the admin's read-only part (people,
     where it comes from, folders inside, the link), the ⋯ entry, five languages; AccessTree's `People` moved into a
     shared component;
   - PERMISSIONS.md (what a member learns about a folder, and that counts can be compared), DECISIONS entry "Who can
     see a folder, in place", CHANGELOG line;
   - tests and screenshots (below).
2. **PR 2, `feat/folder-access-change`** (from dev after PR 1): [Change] and AccessTree's `from=files` way back; its
   tests.

## Risks

- Privacy: the one new answer is a count where the caller can write, which the copy dry run already gives. The security
  tests check that nothing else comes out.
- Load: one count per folder opened (one `access` call per active person); no polling. A count can be stale for
  someone whose own access did not change (`access_changed` reaches only them) until they open the folder again.
- Three counts that must agree: the chip, `Project.audience` and Admin's "Can open". One test checks them on one team.
- Migrations: none (highest on dev: 701). Five languages; 1440 and 390, light and dark.

## Tests

PR 1:

- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` and `tests/unit/docs-site.test.ts`.
- New `tests/security/folder-audience.test.ts` (names the route itself, since the route-coverage check already fails on
  dev):
  - one list of paths asked of both the tree and the new route, as a member: missing, `.system/`, a temp name, a
    refused name, `users/<other>`, a pass-through folder, a link, r3's look-alike names on a hidden non-ASCII folder,
    `users/` and the team root; the answers match the tree's (status and body), except pass-through → 404. A fixture
    with `caseInsensitive: true` asks `Users/<other>` and `SHARED/…` (Linux CI is case-sensitive);
  - a read-only folder answers `{path, access}` only; a writable one has exactly `path, access, people, everyone`;
  - the review's attack: `user:M write` on `groups/finance/public` under `group:finance write, everyone: none` answers
    what the copy dry run of a file from `users/M` there answers plus one; with `user:M read` the answer has no count
    and stays byte-identical when the finance group grows from 2 to 5;
  - switched-off people are not counted; a rule change changes the count; `users/<me>` answers 1; a plugin-managed
    folder under `skills/` answers no count;
  - for every writable folder of a seeded team: `people` = `viewersAdded` + 1 = Admin's read + write; on a project
    folder also `Project.audience`.
- Add the route to the READS list of `tests/security/r3-hidden-vs-missing.test.ts` and a case to
  `tests/security/lib/cases.ts` (`users/alice` by every other persona: 404).
- The files area (`tests/unit/c-files*.test.ts`, `team-folder-basics`, `files-download-only`) and the access suites
  (`tests/unit/access-*.test.ts`).
- Web: `bun run test:web` (new `folder-access.test.tsx`: each chip case and each "no chip" case, a failed request, no
  names in a member's panel), `bun run build:web`; e2e `files.spec.ts`, a new `folder-access.spec.ts` (member, admin and
  owner on the mock server, the ⋯ entry, a project folder's [Members] landing on `?members=1`, the 390 px sheet),
  `access-tree.spec.ts`, `project-participants.spec.ts`. The mock checks the screens only; the security tests above are
  the privacy check.
- Screenshots 1440 and 390, light and dark: member (writable, read-only, own folder, project folder as its creator and
  as another member), admin and owner (team folder, admins-only folder, legacy project folder).

PR 2: `access-tree.spec.ts`, `access-edit.spec.ts`, `access-people.spec.ts`, `folder-access.spec.ts` ([Change], save,
cancel with changes, a 409 from another admin, back to the Files folder, phone full screen), and a unit test that
`from` takes only `files`.

## Review

Two independent reviewers read this plan and the code (product/UX and security). Every must-fix is resolved above.

Product/UX, must-fix:

1. After PR 1 the owner would still see only a count. → The admin's read-only part (names, where it comes from, the
   link) moved into PR 1; PR 2 is only [Change].
2. "Only you" for an admin on a folder only admins can open contradicted "owner and admins included". → "Only you" is
   only for `users/<me>`; admins get "Owner and admins only" there.
3. "If your account is removed, it goes to the owner" was wrong for the owner and for `personalFolder=delete`. →
   Dropped.
4. A legacy project folder (outside `projects/`) gave an admin a dead end. → There the admin keeps the team folder
   panel (and [Change] in PR 2); [Members] lands on #298's legacy note, which links to Admin. #298's files are not
   touched (the coordinator's rule): the panel links to `?members=1` instead of reusing its row.
5. "Can edit / Can view" next to "Read & write / Read". → The `access.*` words throughout; `People` reused as it is.

Product/UX, also taken: #298's chip and headline words, a people icon; the member panel cut to two lines; no chip on
the containers; "folders inside" and By person links for admins; [Change] links to Admin's editor instead of embedding
it; the comparison risk written down; one chip order; more screenshots; the panel closes before [Members].

Security, must-fix:

1. A count on any readable folder leaked group sizes and rules above pass-through folders (`user:M read` on
   `groups/finance/public`), and counts of empty read-only folders. → Members get a count only where they can write
   (decision 1, option D); a test asks the review's attack.
2. The plan's claim about the copy dry run was only partly right. → Decision 1 now says exactly when it holds
   (writable folders, a file from the caller's own folder) and keeps counts to those.
3. The planned "one 404 for everything" did not match `authorize`. → The route answers what the tree answers for the
   same path, except pass-through; tested on one list of paths, with r3's READS list.

Security, also taken: one `RuleSet` per answer, `activePeople`, never `whoAt` rows; a case-insensitive fixture; the route
named in its own test; `users/` and the root pinned.

Second round (both reviewers read the revised plan): security found all three must-fix items closed and no new one;
its notes are in (a count only where `authorize(..., 'write')` passes, so not in plugin-managed folders; the way back
URL-encoded; `access=1` only where the chip shows). Product/UX found its five closed except legacy projects and three
new must-fix items, all resolved: (A) `?members=1` opens nothing on #298's page for someone who cannot change members,
so [Members] shows only with `membersEditable` and the panel says #298's sentence otherwise; (B) every team project
folder, legacy too, gets the `Project.audience` chip, as on the Projects page; (C) admins get the read-only people
list on project folders too.

Found outside this plan (for the manager, separate fixes): `POST /api/projects/access-preview` without a `projectId`
tells a member whether a person is the owner or an admin (the count for `[{user X}]` equals the count for `[]`); the AI
delete card's "cannot restore" number gives the number of editors; the security route-coverage check fails on dev, so a
missing matrix case goes unnoticed.

## Result

Filled in at the end.
