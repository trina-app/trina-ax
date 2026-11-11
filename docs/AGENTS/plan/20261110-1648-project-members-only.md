# Project contents only for members — 프로젝트 내용은 멤버만

- Date (UTC): 2026-11-10 16:48
- Branch: `feat/project-members-only` (this plan); code in the PRs listed under "PR split"
- Status: in progress (built; PR open)
- Where: trina-ax core (`server/src/policy/access.ts`, `server/src/chat/projects.ts`, `chat/shared.ts`,
  `chat/project-access.ts`, `chat/project-members.ts`, `routes/chats.ts`, `routes/admin.ts`, `team-files/service.ts`,
  `files/search.ts`, `devenv/srt/access.ts`, `chat/read-scope.ts`, `chat/shared-answers.ts`, `chat/schedule-scope.ts`,
  `admin/*`, `skills/changes.ts`, `skills/switch-on.ts`, `knowledge-graph/service.ts`, `system/export.ts`,
  `connectors/remote-mcp/groups.ts`, the shared API types, the project, files and admin screens). Why: permissions,
  files, projects and chats are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. The owner and admins lose a kind of access they had, deleting a team project changes, a few
  optional response fields, new words. No schema migration.

## Goal

The owner chose option B (2026-11-10): **a project's contents are visible only to its members.** The owner and admins
no longer read project files and chats by their role. They still see that a project exists, manage its members, rename
and delete it. To read it, an admin adds themselves as a member, which shows in the member list and the activity log.

Why: a project shared only with the group "leads" (3 people) said "5 people see it". The owner and an admin were counted
by role. Today `RuleSet.decide()` gives the owner and admins `write` on every path outside `users/`
(`server/src/policy/access.ts:97`), `projects/<name>/` included.

Ordinary team folders do not change: `shared/`, `groups/…`, `skills/`, the root, `connected/`. Only team projects change.

## The rule

1. **The members-only zone** is every path at or below `projects/<name>/`: any entry directly under the top-level
   `projects/` folder, decided by the path alone, with `projects` compared after NFC and lower-casing (fails closed on a
   case-sensitive volume too). No database lookup, so every `RuleSet` gets it, including the ad-hoc ones
   (`chat/shared.ts:133`, `team-files/service.ts:1658,1699`, `admin/access-edit.ts:37`, `admin/folders.ts:414`).
   `projects/` itself is outside the zone.
2. **Inside the zone the owner and admins are judged as a member with the same groups, by the rules at or below
   `projects/<name>` only.** Their role is taken as `member`, so `role: admin` / `role: owner` rules never apply there,
   and rules on `projects/` or the root never reach in for them (else an admin puts `user:<me> read` on the root and
   reads every project without a floor of its own; security review M1). Members keep today's decision, rules above
   included (no change for them).
3. **The system keeps full access** through an explicit `system: true` on its principal (`admin/folders.ts:43`, today
   `{ id: '\u0000system', role: 'owner' }`), checked first in `decide()`. Never inferred from the role.
4. **Membership** = can read `projects/<name>` by this rule. The member list is the participants (person and group
   `write` rules) plus the other rules on the folder, shown read-only; rules on folders inside are listed only by paths
   the caller can read (a count for the rest).
5. **While a project's folder is in the trash or purged, nobody reads its contents** (shared chats, instructions,
   files). Today admins do (`chat/projects.ts:50`, `chat/shared.ts:84,120,147,433`). The owner and admins see the
   project and restore it, or delete it for good.
6. **The top folder `projects/` never moves, is never renamed and never goes to the trash** (any letter case), and a
   live project's folder never leaves `projects/`. Trash and relocation never rewrite a path out of the zone.
   Otherwise an admin moves `projects` to `archive/` and reads everything (security review M2).
7. **Projects outside `projects/`** (made before 2026-11-09 on an existing team folder, `tests/lib/legacy-project.ts`)
   keep today's rule: their folder is an ordinary team folder, which admins keep. Their page says so (open question 2).
8. **Two checks, never one.** `canSeeProject` keeps its name and means strictly "reads its contents"; its ~40 callers
   then fail closed. A new `mayManageProject(user, row)` (the owner or an admin for any team project; the creator as
   today) is used only by the management routes. `mayEditProject` (instructions, the share switch, a shared chat's
   management) stays "write on the folder and (creator or admin)", so it needs membership.

## What the owner and admins keep (management)

| Action | Route | Change |
|---|---|---|
| See every team project: name, creator, created, member count, in trash | `GET /api/projects?manage=1`, `GET /api/projects/:id?manage=1` (`routes/chats.ts:556,659`) | without `manage` both stay "projects I can read", so pickers (move to project, schedules) and older apps are unchanged. With it, for the owner and admins: rows they do not read carry `member: false`, `instructions: ''`, `canEdit: false`, no `sharedChats`, no `chatUploads`, and `canManage: true` (new optional) |
| Members: read, dry run, save, add themselves | `GET …/access` `:641`, `POST access-preview` `:627`, `PUT …/participants` `:651` | `mayManageProject`; `Project.membersEditable = canManage && accessEditable` |
| Remove an "other rule" | `PUT …/participants` | the members dialog gets × on other rules for whoever manages members; a removal that lets anyone read something they cannot read now is refused (409, the dry run's own check). Admin › Folder permissions no longer writes there (below) |
| Rename | `PATCH /api/projects/:id` `:666` | name only for a non-member (the card's name prompt); never the edit dialog, which always sends `instructions` |
| Delete | `DELETE` `:784-834` | see "Deleting a team project" |
| Restore a project whose folder is in the trash | the trash note on its page | **Restore** (the folder as one item, as the system on the admin's behalf); its rules come back with it (`rebaseFolders`) |
| Repoint a detached project | `PATCH` `:687-699` | only by someone who reads the project's old contents (a member by its parked rules) and the target folder; a purged one is only deleted for good (security review M4) |
| Orphans (no active member: creator deleted or disabled, `keepProjectFloors` `admin/folders.ts:142-151`) | the list | "No active members" on the card; Manage adds someone or themselves |
| `change_project_members` (#310) | `chat/project-members.ts:426-427,473,513,527` | `mayManageProject` in the gate and in `findProject` |
| A dev environment's stop notice | `notifications/service.ts:376-379`, `devenv/jobs.ts:193,216` | kept: project name and stop code; the link opens the management page |

**The page an admin sees for a project they are not in** (`web/src/pages/Projects.tsx`): the name with its menu
(Rename, Delete); the side column's Members row (meta "{n}명", Manage); in place of the box, the files and the
instructions, one quiet block: "Only members see this project's files and chats." and one button, **Add me** (shown
only with `membersEditable`). Below it, the admin's own chats in the project (`GET /api/chats?projectId`, `routes/chats.ts:191`),
so their own earlier work is not hidden. When membership flips either way, the page loads the project, its files and
chats again. Removed for them: the instructions row, the files row, the composer, the chat list of others, "Edit".

**Deleting a team project** (open question 1, the plan's default): `Delete` on a team project in `projects/` moves its
folder to the trash and the project stays listed to the owner and admins as **In trash**, with Restore and **Delete for
good**. The "also move the folder to the trash" checkbox goes. Delete for good is today's delete (the row, its shared
chats to their creators' trash) and purges the folder item. A purge from the files trash does the same. This leaves no
project folder without a project (security review M3: a leftover folder an admin could then open; product review M3: a
folder nobody can manage).

## Paths and their change

PR1 = `feat/project-members-only`; PR2 = `feat/project-members-only-logs`, opened against PR1's branch and merged into
it, so dev gets both in one merge and the dev server (it installs every signed dev build) never runs one without the other.

### Engine and listing (PR1)

| Path | Change |
|---|---|
| `RuleSet.decide()` `policy/access.ts:97-112` | rules 1–3 |
| `hasVisibleDescendant` `:123`, `listing().listable` `:160`, `navigator()` `:227`, edit preview, access tree, srt `folderView` | the same rule, rules above `projects/<name>` left out for owner/admin; else admins list `projects/` children and their sub-folders |
| `explain()` | new reason `members-only` (Admin › By person, the Files panel) |
| Code that assumes "access changes only at a rule folder": `files/search.ts:28-35` `allowedRoots` (and its `filtered=N` count, `files/service.ts:307`), `devenv/srt/access.ts:85-99` `folderView`, `chat/read-scope.ts:50-61` `sourceOf` / `:123-135` `viewersOf`, `candidatesBelow` | every `projects/<name>` is a boundary for these (a `folders` row made for each directory under `projects/`, or one listing of `projects/`; chosen in PR1). The srt sandbox has no per-file recheck, so this is a real read path there |
| Files tree and listing `routes/files.ts:61` → `team-files/service.ts:142-154` | follows the engine: in `projects/` admins see only their projects, like members |
| Moving, renaming or trashing `projects/` (`assertMovable` `team-files/service.ts:285`), moving a project's folder out of `projects/` (`move`, the project follows at `:708`), `relocate` `:724`, `restoreTrash` | refused (403 `protectedFolder` / 409 `project_location`); trash and relocate never rewrite a path out of the zone |
| Making a folder, uploading, moving or pasting directly into `projects/` | refused for everyone (409 `projects_root`); New folder and Upload are hidden there (Files). The server's `makeProjectFolder` and restoring a trashed project folder are the system |

### Files (PR1)

| Path | Change |
|---|---|
| Content, download, HEIC/HWP/office previews, embeds, html-pdf, attachment refs | `authorize()` per request: follow the engine. No signed URL or token skips the check (`share_file` is a plain path; the dev-env preview token rechecks `canSeeProject` each request, `devenv/preview.ts:69-74`). Tests only |
| Version history `service.ts:1468-1480` | `parked === 'unknown'` → owner/admin (`:1475`) is false in the zone; read on `path_at_save` is required when it is in the zone, also when the stamped folder is above the project folder (a repointed or floorless project; security review S3) |
| History timeline `:1529`, `historyPeople` `:1336` | the owner/admin fallback is false in the zone |
| Trash list, restore, purge `:1690-1712` | single items inside a project follow the engine (parked rules); a trashed project folder is the owner's and admins' to restore or purge, as one item |
| The bare trash row after a double failure (#278, `:1205-1225`) | also refused for anything under `projects/<name>/` |
| `GET /api/files/audience` (#306) | counts follow the engine; the project folder's panel uses `folderAccess.project` and drops "(owner and admins included)" |
| `/files?path=projects/<x>` for someone who manages the project but does not read it | goes to `/projects/:id` (Files' `byFolder`), not "folder not found" |
| Search (name `find.ts`, content `content-search.ts:157`, grep `files/search.ts:574-659`), knowledge graph answers (`knowledge-graph/service.ts:766-790,837`, `tool.ts:127`, `chat/turn.ts:2641`), realtime `files.changed` / `files.conflict` | per-hit / per-person checks follow the engine; `allowedRoots` fixed above. Tests only |

### AI, chats, skills, schedules, connector (PR1)

| Path | Change |
|---|---|
| File tools (list, read, grep, glob, copy, move, rename, `delete_files`, `save_url`, `make_file`, `room_file` / `save_room_file`, file placement) | `authorize()` with the principal reloaded per call (`mcp/protocol.ts:45`): follow. Tests only |
| Project instructions in the prompt `chat/runtime.ts:627-631` | `canSeeProject` (strict) |
| Shared chats: `chatFor` → `projectSeenByAll` `chat/shared.ts:426-434`, `Audiences.of` `:84`, `seesUnder` `:120`, `accountSeesProject` `:147` | drop the trashed and purged owner/admin shortcuts |
| A shared chat link for someone who manages but does not read the project | today's "chat not found", plus one line for owners and admins that is the same for any missing chat: "If it's in a project you're not in, add yourself from Projects." (no oracle) |
| Shared-answer withholding `chat/shared-answers.ts` (`ReadGroup.c`) | stored "who saw it then" sets include every admin by role. At the first start of this build owner and admin ids are taken out of every stored `c` (fails closed: they then see an answer only if it was their own turn or they read all its places now) |
| A room's AI reading shared chats `chat/room-project-chats.ts:90,156-160`; `readRooms(exec)` `chat/read-rooms.ts` (#313) | `readRooms` is a taint flag; the reads use `chatFor` and `Audiences.sees`: follow. Tests |
| `post_to_room` / Share to room | chat → room only, through `chatOf 'view'` (`routes/chats.ts:431-434`); nothing posts into a project chat. The provenance card counts a non-member admin in the room as not seeing the project once `sourceOf` is fixed. Tests |
| Project skills, the `/` menu (`routes/memories.ts:138`, `chat/skills.ts:467,703`), `move_skill` / `skill_files` copying out (`skills/move.ts`, `skills/folder-actions.ts:215`) | `authorize` per entry / read on the source: follow. Tests |
| `skillsUnder` (`skills/switch-on.ts:15`, a raw disk read) on repoint `routes/chats.ts:698` | the folder-free check runs first; only skills the caller reads are named; `recordSkillsOn` audit rows keep counts, not paths (security review M4 B) |
| `change_project_members` (#310) | the turn has the caller's file access, so a non-member admin's AI reads no file or chat. The card counts only what the caller reads; for a non-member it says "They'll see its files and chats" instead of numbers. Names and red marks read only the member list. "keeps seeing it as an admin" (`:109,669`) and the other admin wording (`:60,71-86,502`) go |
| Schedules: save folder `chat/schedule-scope.ts:251-268` | `lapseOf` checks write at start, at each covered save and before the write: an admin's schedule into a project they are not in lapses (`access`) with its notice and audit row, existing ones too |
| Schedules: the card's readers and sources (`ruleFingerprint` `:73`) | an engine version joins the fingerprint for paths under `projects/`, so those schedules lapse once (`rules`) and their person answers the card again |
| Notices `notifications/service.ts:527` | drop the trashed-project admin shortcut |
| Dev environment `routes/dev-env.ts:103`, srt | `canSeeProject` (strict); srt boundary above |
| Remote MCP / AI apps (`connectors/remote-mcp/tools.ts:85,158`, `upload.ts`) | per call: follow. `groups_list` (`groups.ts:289`) names only project folders, never paths inside |
| Skill suggestions from a member's own chat (`skills/suggestions.ts:174-185`) | the member chooses to send it to admins: unchanged |
| Engine sessions of owners and admins | reset once at the first start (`resetEngineSessions`), since no rule change runs it: a resumed session must not keep project text it read before (security review S1) |

### Joining (PR1)

| Path | Change |
|---|---|
| Add me, the members dialog, the AI card | one `PUT …/participants`; the `folder.rules` audit row gets `self: true` when the actor gains read (computed, so a group that holds the actor counts too) |
| Group membership (`admin/groups.ts:117`, the connector's `group_update`), an account made or invited into a group (`admin/users.ts:93-148`) | `afterAccessChange` and the account paths find who starts to read each `projects/<name>`: an audit row `project.member_gained` (project id, person, `via`) (security review M5) |
| The notice | when an owner or admin starts to read a project by any path, its members get one quiet stored inbox notice, "{who} joined '{name}'" (+ " through {group}"). Members joining through the members dialog keep today's live `project_access_widened` |

### Admin screens, logs, exports

| Path | Change | PR |
|---|---|---|
| Admin › Folder permissions writes (`routes/admin.ts:135-224` createFolder, putFolderRules, deleteFolder, `folder-rules/preview`, edit preview) anywhere at or under `projects/<name>`, used by a project or not | refused (409 `project_members_only`), checked first on the typed path folded, before any walk or system `authorize`, with one answer whether the path exists or not (security review M3, M6) | 1 |
| `role: admin` / `role: owner` rules inside the zone | removed at the first start (they have no effect any more), audited | 1 |
| Every admin answer that names folders: `GET /api/admin/folders` (`listFolders`), folder-rules preview `below` rows and `previewPath`, `folder.access_lost` details, `via` in `access-explain.ts:63,148`, the access tree `:201-243`, By person `:95-125`, `explainFolder`, knowledge graph `checkAdded` (`service.ts:338`, an existence check), createFolder's error order | one helper cuts `projects/<name>/…` for a viewer who does not read it; a project folder is one tree row ("Members only", its count, "Manage members" → `/projects/:id?members=1`); no rows below it; the same refusal whether a path exists or not (security review M6) | 1 |
| Activity log `admin/audit.ts:66-126` | paths under a project the viewer does not read are cut to `projects/<name>/…` (matched against the known project folders and every directory under `projects/`, not a regex: names have spaces), size and sha256 dropped; every detail key (`file.attach`, `files.ai_trash`, `dev_env.job`, `dev_env.command`, `schedule.save_cover`, `project.update`'s instructions, …) and whole tool summaries that name one; `?path=` inside answers empty | 2 |
| Skill changes log `skills/changes.ts:163` (`from`/`to` too) and `skill_changed` notices `:76-85` | a project skill's change is told only to the owners and admins who read the project, and its creator as today; the log cuts it for the rest | 2 |
| Knowledge graph admin status `knowledge-graph/service.ts:713-739` | failed document paths in a project the viewer does not read are counted, not named; folder rows keep their name and counts | 2 |
| Owner export `system/export.ts:84-140` | every path under `projects/` is judged as the Files tree judges it for the owner (a folder inside they cannot read is left out too; security review M7) | 1 |
| Server backups `system/backup.ts` | still hold everything (a restore needs it); nothing in the app reads them. Docs say so | docs |
| Account powers | an admin who resets a member's password or makes an account can sign in as that person; it signs the member out and is recorded. Docs say so | docs |

### Counts and words (#298, #304, #306, #326, `fix/members-count-apart`) (PR1)

| Path | Change |
|---|---|
| `Project.audience`, `Chat.shared.audience`, `ProjectAccess.people` | follow the engine: members only |
| `Audiences.alone` (`chat/shared.ts:98-111`), "나와 관리자만 봐요" (`chat.whoMeAdmins`, `WhoSees.tsx:17`, `lib/sharedChat.ts:43`) | in `projects/`, alone = nobody else; "You and admins" stays only for projects outside `projects/` |
| New-project and share dry runs (`chat/project-access.ts:257-265`, `routes/chats.ts:757`, `adminsApart` #304) | admins counted only when chosen, for every caller; no `adminsApart` for projects (closes #304's open question for projects) |
| Members dialog line, picker line (`ProjectParticipants.tsx:244`), share switch (`ProjectForm.tsx:173`), folder chip (`lib/folder-access.ts:28,51`) | "멤버 {n}명" for projects; no "(팀장·관리자 포함)"; the tree's "팀장·관리자만" is never said of a project folder |
| "프로젝트 사람 N명이 이 채팅을 볼 수 있어요" | "멤버 N명이 이 채팅을 볼 수 있어요" |
| `fix/members-count-apart` (local branch) | `byRole` is 0 in the zone. If it lands first, PR1 drops its project half and reuses its count key; if PR1 lands first, it drops its project half. The words change once |

### Checklist: the seven places the projects session named

- [ ] 1. `change_project_members` (#310): kept for admins (`mayManageProject`, also in `findProject`); the turn reads
  with the caller's access; the card counts only what the caller reads, else "They'll see its files and chats"; the
  name trace and red marks read only the member list; admin wording goes.
- [ ] 2. Members dialog and counts (#298, #326, `fix/members-count-apart`): "멤버 {n}명", no owner/admin part for
  projects; "You and admins" only outside `projects/`; one change of words with the other branch.
- [ ] 3. `delete_files` → trash, `TeamFiles.remove` with a manifest (#277/#278): items inside a project follow the
  engine (parked rules) in the list and restore; #278's bare-row fallback refused under `projects/<name>/`.
- [ ] 4. `readRooms(exec)` (#313): a taint flag only; every read of a shared project chat goes through `chatFor` /
  `Audiences.sees` (membership by the engine); tests.
- [ ] 5. `post_to_room` / Share to room / pinned sends: nothing posts into a project chat (`chatOf 'view'`, chat →
  room); sending in a shared chat is `chatFor 'continue'`; the provenance card counts non-member admins once
  `sourceOf` has the project boundary; tests.
- [ ] 6. Schedules' save scope (migration 282): write checked at each start, covered save and write → `access` lapse,
  existing schedules too; the fingerprint's engine version re-asks cards under `projects/`.
- [ ] 7. `move_skill` / `skill_files` copying a project skill out: read on the source through `authorize`; tests.

## Admin-created content

- **Files an admin put in a project** before stay; members see them and their history names the admin.
- **Schedules** saving into or reading from a project lapse once with their notice; they run again after the admin
  joins and answers the card, or the save folder is changed.
- **Copies** an admin made out of a project stay where they are.
- **Their own chats in a project** stay theirs and listed under the block; new turns get no instructions or files.
  **Shared chats** of the project leave their list, their pins are dropped (`dropUnseenPins`), their messages stay.
- **A project skill** they made stays in the project. **Room messages** posted before stay in the room.

## Adding oneself

- **Add me**: the confirm "Add yourself to '{name}'? You'll show in its members, and it's in the activity log."
  When the only person a members-dialog save adds is the caller, this confirm replaces "Let more people see it?".
  No separate "+ me" in the dialog (the picker finds you).
- **Logged** (`self: true`), **visible** (a participant like anyone), **told** (the stored notice above). Removing
  oneself works as for anyone, and the page closes again.

## Migration

No schema migration. Access stops when the server starts on this build. One-time steps at that first start, each
idempotent and audited once: (1) owner and admin ids out of `shared_answer_reads` `c`; (2) schedules under `projects/`
checked again (the fingerprint); (3) `role: admin` / `role: owner` rules inside the zone removed; (4) engine sessions of
owners and admins reset; (5) if PR1 picks `folders` rows as boundaries, a row for every directory under `projects/`,
and versions and trash rows stamped with the project folder.

## UI text (English first; ko beside it; id, ja, es in the PR)

| Key (proposed) | English | 한국어 |
|---|---|---|
| `projects.membersOnly` | Only members see this project's files and chats. | 이 프로젝트의 파일과 채팅은 멤버만 봐요. |
| `projects.addMe` | Add me | 나를 멤버로 추가 |
| `projects.addMeTitle` | Add yourself to '{name}'? | '{name}'에 나를 추가할까요? |
| `projects.addMeBody` | You'll show in its members, and it's in the activity log. | 멤버 목록에 내 이름이 보이고 활동 기록에 남아요. |
| members row meta, dialog line | {n} / {n} members | {n}명 / 멤버 {n}명 |
| `projects.noMembers` (list card) | No active members | 활동 중인 멤버 없음 |
| `projects.othersSee` (card, non-member adding others) | They'll see its files and chats. | 이 사람들은 파일과 채팅을 보게 돼요. |
| `projects.rulesInsideCount` | {n} folders inside have their own rules | 안쪽 폴더 {n}개에 따로 정한 규칙이 있어요 |
| `projects.trashNote` | This project is in the trash. | 이 프로젝트는 휴지통에 있어요. |
| `projects.deleteForGood` | Delete for good | 완전히 삭제 |
| `projects.joined` (server notice, `chat/i18n.ts`) | {who} joined '{name}'. | {who}님이 '{name}' 프로젝트에 들어왔어요. |
| `projects.legacyNote` (merged) | This project is outside Projects ({folder}), so the owner and admins see it too. Change who sees it in Admin › Folder permissions. | 이 프로젝트는 프로젝트 폴더 밖({folder})에 있어서 팀장·관리자도 봐요. 볼 수 있는 사람은 관리자 › 폴더 권한에서 바꿔요. |
| `accessTree.membersOnly` | Members only | 멤버만 |
| refusal `project_members_only` | Project members are changed on the project's page. | 프로젝트 멤버는 프로젝트 페이지에서 바꿔요. |
| refusal `projects_root` | Make a project instead. Folders here are projects. | 여기에는 프로젝트를 만들어 주세요. |
| chat not found, owner/admin line | If it's in a project you're not in, add yourself from Projects. | 내가 멤버가 아닌 프로젝트의 채팅이면 프로젝트에서 나를 추가해 주세요. |
| group / member delete confirm | {n} projects will have no members. | 프로젝트 {n}개에 멤버가 남지 않아요. |

Removed for projects in `projects/`: "(owner and admins included)", "and the owner and admins see it", "You and admins",
"keeps seeing it as an admin", the delete checkbox, the "See folder permissions" link for other rules, "Not a member"
tags (the page says it). Docs: `docs/PERMISSIONS.md` (rows `projects/<name>/`, 채팅, 공유 프로젝트 채팅, Project
skills), `docs/for-admins*.md`, `docs/security-and-permissions*.md`, a `docs/DECISIONS.md` entry,
`changes/project-members-only.md`.

## Steps

1. PR1 server: the zone, the system flag, rules above ignored for owner/admin, the list shortcuts, `explain`; the
   boundaries; the top-folder and move guards; `canSeeProject` strict, `mayManageProject`, `?manage=1`, the management
   routes, delete to trash, restore, repoint; the trashed/purged shortcuts; versions and trash fallbacks; shared-answer
   cleanup; schedule fingerprint; export; joining audit and notice; Admin writes refused and admin answers cut;
   `change_project_members`; counts and `alone`; the one-time steps; a guard test listing every remaining
   `role === 'owner' || role === 'admin'` / `isAdminRole(` site in `server/src` with its reason, so a new one fails CI.
2. PR1 web: the non-member page and its reloads, Add me, Restore and Delete for good, card menus from `canManage`,
   the Files redirect and hidden buttons in `projects/`, the words, the mock server. Five languages, docs, DECISIONS,
   `changes/`.
3. PR2 (against PR1's branch): activity log, skill changes log and notices, knowledge graph status.
4. A deep security review and a product review of the diff before PR1 (with PR2 in it) merges to dev.

## Tests

- Always: `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` + `tests/unit/docs-site.test.ts`.
- Unit: every file of the touched prefixes (`access-*`, `project-*`, `b-project-*`, `b-shared-chat-*`, `b-who-sees`,
  `c-kg-*`, `c-knowledge-graph-*`, `ai-delete-files`, schedules, audit, skills, `security-route-coverage`), with
  `access-explain-equivalence` and `access-tree-equivalence` extended to the zone.
- **Security matrix** (`tests/security/lib/world.ts`): dana (owner) and carol (admin) are not members of "Team plan"
  (alice + erin). New canaries there: a file, a file name, a sub-folder name, an old version, a trashed file name, the
  instructions, a shared chat message, a project skill's description. Deny rows for dana and carol, also (a) with
  `role: admin` on the folder, (b) with `user:carol read` and `everyone: read` on the root and on `projects/`, (c) while
  the folder is in the trash: list, content, download, every preview, embed, html-pdf, attachment refs, history, version
  file, trash list and restore of an item inside, name/content/grep search and its `filtered` count, knowledge graph
  explore, lookup and meaning hits, audience inside, project GET with and without `manage`, chat list `?projectId`,
  chat GET, messages, chat search, a room's `project_chats`, send in the shared chat, schedule save (lapse), export
  (also a folder inside dana cannot read while a member), MCP read/search/list, dev env routes, srt run lists, every
  Admin write under `projects/<name>` (existing path and missing path give the same answer), every admin answer that
  names folders, repoint of the trashed project and a decoy repoint at its folder (no skill canary), moving, renaming
  (`Projects`) and trashing `projects/`, moving the project folder out, and (PR2) the activity log, skill changes log
  and notice, knowledge graph status. Allow rows: the list and GET with `manage` (name, creator, count), access, dry
  run, participants (add self), rename, delete to trash, restore, delete for good; after adding themselves the content
  rows flip to allow; carol added to "leads" and a new account made in "leads" → audit row and stored notice to alice
  and erin. `projects/falcon` (older, admin-made, no floor): dana and carol are denied `plan.md`, still list `public/`
  (everyone read inside); bob still reads it.
- E2E (Chromium, 1440 and 390): `project-page.spec.ts` (non-member admin: the block, Add me, files after; leaving
  again), `project-participants.spec.ts`, `project-list-menu.spec.ts` (Rename, Members, Delete for a non-member admin;
  In trash, Restore, Delete for good), `shared-project-chats.spec.ts`, `folder-access.spec.ts`, `access-tree.spec.ts`.
  The full web e2e before the merge (shared, risky change).

## Risks

- **A missed role shortcut** reads around the rule. Mitigation: the guard test, the matrix, the deep review.
- **The system principal**: anything else that builds an owner principal for server work breaks in the zone; the guard
  test covers new ones.
- **Admins locked out when they need in**: Add me, recorded and told. Backups and the server disk hold everything.
- **Account powers** stay (password reset, spare accounts); recorded, noisy, documented.
- **Legacy projects outside `projects/`** stay visible to admins (open question 2).
- **In-flight branches**: `fix/members-count-apart`, anything in `chat/project-access.ts`, `chat/shared.ts`,
  `policy/access.ts`, `team-files/service.ts`. Rebase late.
- **Older apps** do not send `manage=1`, so they list only projects the person reads: no broken page.
- **Past disclosures** (room posts, exports already made) stay.
- Public repo: tests use `acme` names only.

## Review

Two independent reviewers read this plan and the code (2026-11-10).

Security (tried to read a project as a non-member owner or admin through every path): 7 must-fix, all taken.
- M1 rules on the root or `projects/` reached inside (an admin puts `user:<me> read` on the root): owner/admin are
  judged by the rules at or below `projects/<name>` only (rule 2).
- M2 the top `projects/` could be moved or renamed (also by case) and restored out of the zone: rule 6, the zone name
  folded, trash and relocate never leave the zone.
- M3 delete the project, then put a rule on its leftover folder: every Admin write under `projects/<name>` is refused,
  used or not; delete moves the folder to the trash with the project (no leftover).
- M4 repointing a detached project at a folder the admin controls, and `skillsUnder` naming skills before the
  folder-free check: repoint only by a member of its old contents; the check first; only readable skill names.
- M5 an admin joining a participant group was silent: `project.member_gained` audit rows and a stored notice from
  every access path, `self` computed.
- M6 admin answers named folders inside projects and some told existence: one cutting helper, one refusal for present
  and missing paths, in PR1.
- M7 the export left in folders inside a project the owner cannot read: judged per path.
- Should-fix taken: engine sessions reset, a project folder cannot leave `projects/`, `path_at_save` in the zone, the
  activity log cut by known folders and every detail key, PR1 and PR2 merged together, docs on account powers. Nits
  taken: `findProject`, the grep count, `sharedChats` for non-members, `projects_root` lets a restore through, the falcon
  row, the stop notice link.

Product (the admin's experience and the owner's mental model): 5 must-fix, all taken.
- M1 `canEdit: false` hid Rename, Delete and Manage and showed "folder not in its place": `canManage`, and
  `membersEditable` from it; Rename without the edit dialog.
- M2 a trashed project was a dead end: Restore on its page; repoint only where allowed.
- M3 a deleted project's folder became a folder nobody manages: delete to trash with the project (open question 1).
- M4 "other rules" sent people to Folder permissions, which now refuses: × in the members dialog, narrowing only;
  role rules for admins removed at the first start.
- M5 the PR split left the dev server saying the old thing: the admin tree and By person in PR1, PR2 merged into PR1.
- Should-fix taken: `?manage=1` keeps pickers and older apps as they are; reloads on joining and leaving and the admin's
  own chats under the block; the confirm promises only what happens; the card for adding others; "No active members"
  and the delete confirms; the Files redirect and the chat-not-found line; New folder and Upload hidden in `projects/`.
  Nits taken: the row meta, reuse of `folderAccess.project`, the merged legacy line, "팀장·관리자", the refusal wording,
  the notice wording, no "Not a member" tag, "멤버 N명" in the chat line.

## Open questions for the owner

1. **Deleting a team project moves its folder to the trash, always** (the checkbox goes; Restore brings both back;
   Delete for good after). Recommended: yes. It is what keeps a deleted project's folder from being opened by an admin
   or left with nobody to manage it.
2. **Projects made before 2026-11-09 outside `projects/` keep admin access**, with a line saying so. Recommended: yes
   (their folders are ordinary team folders, which stay as they are). Count them on the team servers first; a "Move into
   Projects" action can come later if any exist.
3. **No "transfer project" when its creator leaves.** Recommended: none; admins manage its members without joining.
4. **No notice to admins at the upgrade**; the changelog and the project page say it. Recommended: as proposed.

## Result

Built as one PR (PR1 and PR2 together, as the reviews asked). The coordinator applied the four recommended answers as
defaults the owner may change (DECISIONS "Project contents only for members"). What differs from the plan, and why:

- **No new reason `members-only` in `explain()`.** An owner or admin inside the zone without a rule gets `no-rule` (or
  the `rule` that decided, e.g. "everyone else: none"), which the admin screens already word; Admin shows the project
  folder as "Members only" by its kind instead.
- **Boundaries:** a listing of `projects/` (policy/zone.ts) for search roots and the srt sandbox, and a `folders` row
  for `projects/<name>` made by `sourceOf` when a read needs one. No start-up step for them.
- **Schedules:** instead of an engine version in the fingerprint, the one-time start step lapses every schedule with a
  save folder or a source under `projects/` (same effect, no change to the fingerprint).
- **Making a folder directly in `projects/`** needs no new 409: the engine already refuses it (no rule there for an
  admin's new name); the Files screen hides New folder and Upload there.
- **The joined notice** is stored (migration 284 `project_notices`, add-only), so a notice is never lost to an offline
  member; it covers every path (Add me, members dialog, AI card, group changes, new accounts).
- **#341 (`fix/members-count-apart`) landed first.** Its split stays; for projects its role part is 0 and the project
  role lines are gone; its changes note was trimmed to the folder chip.
- **A project made for the dev environment on the team root** (`routes/dev-env.ts giveProjectFolder`): its
  `projects/<name>` is made as the system, and the admin who turns the box on becomes a member by name.
- **Leftover folders** (in `projects/` with no project) become projects when the owner or an admin opens the projects
  they manage, not at start (a new team may make its folders first).
- **Making something directly in `projects/`** answers one plain sentence ("only a new project makes a folder
  directly in 'projects/'"), the same whether the name exists or not.
- **The deep code review** found three ways in (a join while the project is in the trash, a rule on a folder inside a
  project, names with quotes in the log) and a member trashing an admin's folder through an older project; all fixed
  and in `tests/security/project-members-only.test.ts`. The owner and admins now read inside a project only once they
  read its folder.
- **Not counted:** legacy projects on the team servers (no read-only way from the code or fixtures).
