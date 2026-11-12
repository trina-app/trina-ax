# "Who can open it": the folder panel, as simple as Drive's Share dialog

- Date (UTC): 2026-11-10 17:15
- Branch: `feat/drive-like-access`
- Status: done (PR #346; the owner approved option A, 2026-11-11)
- Where: Team AX core: `web/src/components/FolderAccess.tsx`, a new `web/src/pages/admin/FolderSharing.tsx` (replaces
  `FolderAccessAdmin.tsx`), a hook taken out of `web/src/pages/admin/AccessEdit.tsx`, `web/src/lib/folder-access.ts`,
  one optional field in `server/src/admin/access-edit.ts` and `shared/src/api/admin.ts`. Why: files and permissions
  are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. One optional field on an admin answer; the panel changes for admins (they edit in place).
  No migration, no new endpoint, no change to what a member learns.
- Builds on #306/#307 (on dev). Coordinates with #341 (`fix/members-count-apart`), `feat/project-members-only`
  (planned) and #339 (`feat/phone-page-patterns`, in review); see "Coordination".

## Goal

The owner, after #306/#307: "It still looks much harder than Google Drive. Is there no way around that?"

What an admin sees today on `shared/` ("Company-wide"): a headline, a red "2 folders inside have their own rules" line,
[Set rules], a counts line ("Can open: 3 · Can write: 3 · Cannot open: 4"), then **every** team member, one row each,
with role, an access badge and a reason ("Name only — Only the name shows, on the way to shared/Sales, …"; "Read &
write — Admins see everything except …"), then "See folder permissions". It lists people who cannot open the folder,
shows the internal pass-through idea, repeats each role's explanation, and nothing can be changed there: [Set rules]
leaves for Admin's editor.

After this change the panel is Drive's Share dialog in our words: the people and groups who can open the folder, one
general access setting, one footer line, and an admin changes them right there. This replaces #307's "not a second
editor in Files" (DECISIONS, 2026-11-10): the owner now asks for editing in place.

## Principles

1. **An office worker, not a developer, reads it in a few seconds** (owner rule, 2026-11-10). Our users are ordinary
   office workers. Every word on the panel says an outcome: "Who can open it", "Can view", "Can edit", "Only people
   added here", "Everyone at {team}". Never "rule", "inherited", "grant", "access level", a path or a slash. Where
   access comes from a folder above, the most the panel says is "From the {folder} folder".
2. **Rows read like Drive's list**: a face or a group tile, a name, and what they can do. No technical rows, no
   counts lines, no reasons.
3. **Every control says what will happen, by name, before anything is saved**: after a change the list shows the
   result and one plain line names who will gain or lose access. Nothing is saved until Save.
4. **Members learn nothing new** (#306's decision 1 stands).
5. **Admin › Folder permissions stays the full view** for the rare deep cases; the panel links to it in one line.

The words "rule", "grant", "inherited" below are this plan's words for developers; none of them reaches the screen.

## References (official help pages, read 2026-11-10; the screens themselves were not opened)

| | Google Drive | Notion |
|---|---|---|
| Add | "Share": one field for an email or a Google Group, a role, "Send" [G1] | "Share": find members or groups by name, a level, "Invite" [N1] |
| List | a down arrow by each person; "Remove access", then "Save" [G1][G2] | "each person, group, or teamspace with access" has its own dropdown; "Remove" [N1] |
| Levels | Viewer / Commenter / Editor [G1] | Full access / Can edit / Can comment / Can view [N1] |
| General access | one dropdown: "Restricted", "Your organization", "Anyone with the link", with a role [G1][G2] | "Only people invited", "Everyone at {workspace}", "Anyone on the web with link", each with a level [N1] |
| From a folder above | items inherit the folder's sharing; "You can't give someone less access to a file than they have on its parent folder" [G2]; the API marks each permission `inherited` [G4] | "a subpage will take on the permissions of its parent page" [N1] |
| Several sources | (follows from the above: access only adds up) | "Notion respects the broadest level of access given to a user" [N1] |
| Narrower here | only a "Limit access" folder; it lists people the parent lets in under "Access removed", and "People with access" and "General access" override that list [G3][G4] | not described |

Sources: [G1](https://support.google.com/drive/answer/2494822?hl=en&co=GENIE.Platform%3DDesktop) (Share files),
[G2](https://support.google.com/drive/answer/7166529?hl=en&co=GENIE.Platform%3DDesktop) (Share folders),
[G3](https://support.google.com/drive/answer/14254362?hl=en&co=GENIE.Platform%3DDesktop) (limited access folders),
[G4](https://developers.google.com/drive/api/guides/limited-expansive-access) (Drive API, limited and expansive access),
[N1](https://www.notion.com/help/sharing-and-permissions) (Notion, Sharing & permissions).
Not confirmed from the pages: the exact per-row wording for an entry from a parent (third-party guides say "Inherited
from parent page"; Notion's help does not), whether a group row shows its size, whether Drive needs "Save" after a role
change (the page says so only after "Remove access"), and what someone who cannot share sees beyond their own level.

What we take: one add field at the top; one row per person or group with a select and a way to remove it; one general
access dropdown; changes collected, then saved; access from a folder above shown, and changed in that folder. What we
do not take: links, guests, Commenter, expiry, "Notify people" (our access-changed notices already go out), and the
names list for people who cannot share (our members keep #306's count).

## How our rules map onto Drive's, and where they differ

A folder carries rules (`folder_rules`): person, group, everyone (old role rows read as "everyone",
`lib/access-edit.ts`). For each person the **deepest** folder with a rule for them decides; inside it a person rule
beats their group rules (the widest group wins), which beat everyone (`server/src/policy/access.ts`). The owner and
admins write everywhere outside `users/`.

| Drive | Ours (the rules of this folder) |
|---|---|
| a person or group in "People with access" | a person or group rule here with read or write |
| an entry from a parent folder | a person or group rule on a folder above that decides for someone here (`AccessTreeWho`, `folder` ≠ this one) |
| General access "Restricted" | `everyone: none` here ("Only people added here"). It also shuts out what folders above give, like Drive's "Limit access" [G3] |
| General access "Your organization" + role | `everyone: read` / `everyone: write` here ("Everyone at {team} · Can view / Can edit") |
| (general access from a parent) | no everyone rule here: "Same as the {folder} folder" |
| "Access removed" | a person or group rule with `none`. Not the same: in Drive the other lists override it [G3]; ours beats the person's groups and everyone |

Where we differ from both Drive and Notion (deepest wins, not broadest [N1]): a setting here can give someone **less**
than a folder above, and a person's own setting beats their group's even when it is narrower. So adding a group can
lower someone who could edit through a folder above. The panel never lets that pass unseen: the "What will happen"
line names them before Save (1.4), and a row says "In Sales, but can only view here". Changing the rule to "broadest
wins" is not in this plan (open question 1).

## Design

### 1. The admin panel (a team folder outside `projects/`, as #307 offers [Set rules] today)

The app's `Modal` (520 px; a bottom sheet below 640 px). Title "Who can open it"; under it only the folder's own name in
the Files page's words (`useFolderWords`: "Company-wide", "Quotes"), never a path. From the top:

1. **Add field**: "Add people or groups" (`AddNamed`, inline mode). Picking one adds a row at the top of the list with
   "Can view" and focuses its select. Not offered: people and groups already in the list, the owner and admins (they
   can always open it; a setting would change nothing).
2. **The list** (no heading: the title says it), groups first, then people, by name:
   - a group: its tile, the name, "Group · 5 people" under it (its size, as Admin › Groups counts it), never opened up;
   - a person: face and name, "Member" under it, "Switched off" when the account is; an owner or admin row that exists from before says "Can always open and edit it" in
     place of the select;
   - a select "Can view / Can edit" and ✕ ("Remove {name}"). In a connected folder one line under the list says "This
     folder is a copy of another one. Changes made here don't go back to it.";
   - a person in a group listed here with a different setting gets one quiet line: "In Sales, but can only view
     here" / "…can edit here" / "…can't open it here";
   - **rows from folders above**, after them, greyed: the group or person, "Can view" / "Can edit" / "No access" as
     text, and "From the Sales folder · Change there ›" ("From the team folder" for the top). The whole row (44 px)
     opens that folder's panel in place, with "‹ Quotes" to come back. For the top of the team folder and `groups/`,
     `projects/`, `connected/` themselves, which have no panel, it opens Admin › Folder permissions there;
   - a person or group set to "No access" here: the same row, its select saying "No access" (options Can view, Can
     edit, No access), sorted last. "No access" is offered only on such rows; setting someone new to "No access" is done
     in Admin › Folder permissions (rare);
   - nothing to list: "No one is added yet."
3. **General access** ("공개 범위" in Korean): one select, the choices of Admin's "Basic access" (`basicChoices`):
   - "Same as the Sales folder" (not at the top; not on `shared/` and `skills/` unless set now: they must keep a
     setting of their own);
   - "Only people added here";
   - "Everyone at {team} · Can view";
   - "Everyone at {team} · Can edit" (not in a connected folder unless set now).

   Under it, one line that is true for what is on screen:
   - Same as: what that folder gives: "Only the people in the list can open it." / "Anyone at {team} can view it."
     / "Anyone at {team} can view and edit it." (from `everyoneAbove`; the first is true also when the greyed rows
     come from several folders up);
   - Only people added here: "Only the people above can open it.", or with an empty list "Only the owner and admins can
     open it.";
   - Everyone: "Anyone at {team} can open it." / "…can open and edit it.";
   - any of these with a "No access" row: a second sentence, "People set to No access can't."
4. **What will happen** (only while something is changed): one line above the buttons, from the server's answer for
   exactly the draft on screen, built from `changes[]` (before → after, names): "alice and bob will be able to open
   it", "carol will be able to edit it", "dan will no longer be able to open it", "erin will only be able to view
   it"; at most three names per part, then "and 4 others"; in `skills/`, losing edit reads "…will no longer be able to
   change the team's skills". Nothing changes: "No one's access changes." While the answer is on its way the line and
   the greyed rows dim; nothing on screen is computed by the web.
5. **Footer line**, quiet: "Owner and admins can always open team folders."
6. **One link**: "2 folders inside are shared differently · Open in Folder permissions" when folders below have their
   own settings (today's `rules=1` ask), else "Open in Folder permissions"; both go to Admin › Folder permissions at
   this folder.
7. **Buttons**: [Done] while nothing changed; once something did, [Cancel] and [Save].

No headline, no counts line, no reasons, no one listed who cannot open it, no paths.

### 2. Editing in place

- **One draft, one code path.** The draft (`Draft`, `lib/access-edit.ts`), the preview (`POST
  /api/admin/access/edit-preview`), the starting rules hash, the save (`PUT /api/admin/folders/:id/rules`, or `POST
  /api/admin/folders` with `create: false` when the folder has no rule row), the 409 handling and the leave guard move
  out of `AccessEdit.tsx` into one hook (`useRulesDraft`) used by both. Admin's editor does not change.
- **Keyed by folder.** The panel's body is mounted with `key={path}` (also when "Change there" swaps folders and when
  coming back), as AccessTree mounts Admin's editor; the answer's key is the path plus the rules, so an answer for
  another folder never counts as ready. The draft lives above the chip's refresh (`accessChanged`), so a refresh never
  unmounts it.
- **Save always sends `expectedHash`.** It stays disabled until the answer for exactly the draft on screen is in
  (today's `why`). After each save and each folder swap the folder list (`GET /api/admin/folders`) is read again; a 409
  `folderExists` is handled like `rules_changed` (asked again, the draft kept); the server adds `params.reason:
  'folder_exists'` to it in PR 1, so the client need not guess from a bare conflict.
- **On Save, ask once more.** Save asks the preview again at once (no debounce) for the draft and decides from that
  answer. If it differs from what "What will happen" showed (someone changed a folder above, a group, a role), the
  panel shows the new answer and Save needs another click. The confirm's own button ([Give access], [Save anyway])
  asks once more the same way before the write, so a confirm left open covers nothing. Double clicks and Enter give
  one request.
- **Confirm before more access.** Save asks once when any of these holds, comparing the draft with the stored rules
  (and with `everyoneAbove` where the folder follows the one above), not only the head count:
  - the fresh answer says someone gains (`changes` with direction `more`), here or in a folder inside;
  - a person or group row is added with Can view/Can edit, raised, or a "No access" row is raised or removed; a row
    removed that names a switched-off person, or a group with one, when the folder's general access (or the one
    above's, via `everyoneAbove`) gives more than that row did (switched-off people are not counted, and they get
    that access when switched back on);
  - general access goes up (everyone gets more than now, even when today nobody is counted for it);
  - the answer carries `skills-everyone-writes`.

  The confirm: title "Let 2 more people open it?" (or "Let 3 people edit it?" when no one new can open it; or "Give
  more access?" when no one is counted), the names as in 1.4, "They can also open 2 folders inside." when `below` is
  not empty, the warning in plain words, [Give access] / [Cancel] (the draft stays).
- **Confirm before taking the team's files away.** When the fresh answer carries `team-files` or `team-instructions`,
  Save asks with its own words: "12 people and their AI will no longer be able to open Company-wide." / "…will no longer be able
  to use the team's skills.", [Save anyway]. Both kinds at once: one dialog, both parts.
- Other narrowing saves go straight (as in Admin's editor): "What will happen" has named who loses access.
- Old role rows: saving rewrites them without changing anyone's access (`lib/access-edit.ts`); the panel says nothing.
- Another admin's change while the panel is open: "Someone else changed this just now. Saving replaces their change."
  with [Show theirs] (loads theirs, drops the draft), or, when nothing was changed here, "Someone else changed this
  just now." and their version shown.

### 3. The member panel (the same facts as today)

Members keep #306's decision: a count only where they can write, their own folder, and the projects they see. The panel
takes the new title and "open" in its words; the facts are #306's:

- a folder they can write: "Everyone at {team} can open it" (`everyone`) or "{n} people can open it (owner and admins
  included)" (`people`), then "An admin changes who can open it.";
- their own folder: "Only you can open it." and "Admins can't open it either.";
- a team project's folder: #306's project lines, as today.

No add field, no rows, no Can view / Can edit (today a member never learns whether everyone can edit), no "Same as",
no footer, no link to Admin. A folder they can only view or pass through still has no chip and no panel entry. The
admin parts stay in a chunk loaded only for admins, and every admin read and write is refused to members by the server.

### 4. Special folders

| Folder | Admin panel | Member panel |
|---|---|---|
| `shared/`, `skills/` | editable; "Same as" not offered (they keep a setting of their own) | count where they write |
| inside `skills/` | editable; "Can edit" means "can change the team's skills" (one line under the list says so); everyone editing confirms with "Everyone will be able to change the skills every AI follows." | count where they write (usually view only: none) |
| `groups/<g>/` and inside | editable | count where they write |
| `connected/<name>/` and inside | editable; no "Everyone · Can edit"; the copy line | count where they write (view only: none) |
| `projects/<name>/` and every folder inside it | **not edited here, and no admin request** (the chip's `askSelf` too: today `useFolderAccess` asks the tree for admins there): the count from the folder's `GET /api/files/audience` (a member: "6 people can open it (owner and admins included)"; an admin: #341's split, "3 people can open it" and its role line, never the "included" suffix); on the project's own folder "Who can open it follows the project's members.", [Members] or #298's sentence, "Open project"; inside it no such line (a folder inside can still have settings of its own today, which the panel does not read), and "Open in Folder permissions" for admins | the project's lines as today; inside it, the count where they write |
| a project outside `projects/` (made before 2026-11-09) | editable (as #307), plus the project line and #298's note | the project's lines |
| `users/<me>/…` | "Only you can open it. Admins can't open it either." | the same |
| the top of the team folder, `users/`, `groups/`, `projects/`, `connected/` | no panel (as today) | no panel |

`projects/` is read only in the panel from PR 1: the owner chose "project contents members-only"
(`feat/project-members-only`), which refuses admin rule writes and the admin answers there. Today Admin › Folder
permissions still edits rules inside a project; that stays until that branch lands. Whether the panel edits a folder
is one predicate (`editableHere`, today's `changeHere`), and which footer it shows is another (`footerOf`).

### 5. Phones

The same panel as a bottom sheet (`Modal` below 640 px) with #339's row (`CompactRow`): the name and its select on one
line (the select as the chip, ✕ as the 44 px end button), a second line only when it says something ("Group · 5 people",
"From the Sales folder"). Greyed rows are 44 px tap targets as a whole. The General access line sits under its select
(the select's text may be cut; the line is not). The add field's list opens in the flow (`AddNamed inline`) and the
sheet grows to full height while it is open. "What will happen" and Save sit in the sheet's footer above the home
indicator; the confirm opens over the sheet; "Change there" swaps the sheet's content, so no sheet opens over another.
If #339 is not on dev when this is built, the rows use the same classes and switch to `CompactRow` when it lands.

### 6. Removed from the panel

- the rows of people who cannot open it, and with them "Name only" / "on the way to";
- the reason under each person and a row for each admin;
- the counts line ("Can open: 3 · Can write: 3 · Cannot open: 4");
- the headline and #341's role line for admins (the chip keeps #341's count);
- the red "2 folders inside have their own rules" line (now the quiet line in 1.6);
- [Set rules] and the trip to Admin's editor for everyday changes; "Load more"; switched-off people listed apart;
  every path.

Admin › Folder permissions (By folder, By person, the full editor) stays as it is, for the deep cases: setting someone
to "No access", why one person can open something, every folder at once. Its `from=files` way back stays.

## Data and API

- Admin panel reads (admin endpoints, as Admin's page reads them): `GET /api/admin/folders` (the folder's rule row,
  `rulesHash`, `keep`), `GET /api/admin/users` and `/api/admin/groups` (names, roles, group sizes, the add field),
  `GET /api/admin/access/tree?path=&limit=1` (already asked for the chip) and `?rules=1&limit=1` (folders below with
  their own settings), and the edit preview with the stored rules at once on opening, then for each draft. None of
  them on a `projects/` folder or inside one.
- **One new optional field** on `FolderEditPreview` (admin only): `everyoneAbove: { access, folder } | null`: what a
  member that no person or group rule names would get here if this folder had no rules, and the folder whose rule
  decides that (`''` = the top of the team folder: "the team folder"; `folder: null` with `none`: no folder above
  lets everyone in: "Only the people in the list can open it", the folder named being the one right above). `null` at
  the top. Computed with `RuleSet.explain` for a member principal with no groups and an id no person can have
  (`'\u0000everyone'`, as `explainNewPerson` makes its own), in `server/src/admin/access-edit.ts`, which the web mock
  server shares. Deriving it from the grouped `above` fails when every member happens to be named by a group rule.
- Rows from folders above come only from the ready answer's `next` (`AccessTreeWho` with `reason: 'rule'`, `folder` ≠
  this folder, a person or group subject; `none` ones as "No access" rows). Rows set here come from the draft.
- Writes: only the existing `PUT /api/admin/folders/:id/rules` and `POST /api/admin/folders`, with their checks: admin
  only, `users/` refused, `shared/` and `skills/` keep a rule, subjects must exist and appear once, the rules hash
  (409), the audit row, `afterAccessChange` (notices, fresh AI sessions for people who lose access). Two small
  hardenings in PR 1: `CreateFolderBody.rules` gets the `.max(200)` that `PutRulesBody` has, and the `folderExists`
  conflict gets `params.reason: 'folder_exists'`.
- Members: `GET /api/files/audience` and `Project.audience` as today. Nothing new; `everyoneAbove` is only on an
  answer the server refuses to members.

## Copy (English first; id, ja, es in the PR, each checked against its neighbours)

Every string passes principle 1: an office worker understands it and knows what a select will do.

| Key | en | ko |
|---|---|---|
| `folderAccess.menu` (title, ⋯ entry; changed) | Who can open it | 열 수 있는 사람 |
| `folderAccess.add` | Add people or groups | 사람이나 부서 추가 |
| `folderAccess.canView` | Can view | 볼 수 있음 |
| `folderAccess.canEdit` | Can edit | 고칠 수 있음 |
| `folderAccess.noAccess` | No access | 열 수 없음 |
| `folderAccess.always` (an owner or admin row) | Can always open and edit it | 언제나 열고 고칠 수 있음 |
| `folderAccess.inGroupView` / `Edit` / `None` | In {group}, but can only view here / can edit here / can't open it here | {group}에 속하지만 여기선 보기만 가능 / 고칠 수 있음 / 열 수 없음 |
| `folderAccess.fromFolder` | From the {folder} folder | '{folder}' 폴더에서 |
| `folderAccess.fromTop` | From the team folder | 팀 폴더에서 |
| `folderAccess.changeThere` | Change there | 거기서 바꾸기 |
| `folderAccess.backTo` | ‹ {folder} | ‹ {folder} |
| `folderAccess.noneAdded` | No one is added yet. | 아직 추가한 사람이 없어요. |
| `folderAccess.general` | General access | 공개 범위 |
| `folderAccess.sameAs` | Same as the {folder} folder | '{folder}' 폴더와 같게 |
| `folderAccess.onlyHere` | Only people added here | 여기 추가한 사람만 |
| `folderAccess.everyoneView` / `Edit` | Everyone at {team} · Can view / Can edit | {team} 모두 · 볼 수 있음 / 고칠 수 있음 |
| `folderAccess.hintAboveOnly` | Only the people in the list can open it. | 목록에 있는 사람만 열 수 있어요. |
| `folderAccess.hintAboveView` / `Edit` | Anyone at {team} can view it. / Anyone at {team} can view and edit it. | {team} 누구나 볼 수 있어요. / {team} 누구나 보고 고칠 수 있어요. |
| `folderAccess.hintOnly` | Only the people above can open it. | 위에 있는 사람만 열 수 있어요. |
| `folderAccess.hintAdminsOnly` | Only the owner and admins can open it. | 팀장과 관리자만 열 수 있어요. |
| `folderAccess.hintEveryoneView` / `Edit` | Anyone at {team} can open it. / Anyone at {team} can open and edit it. | {team} 누구나 열 수 있어요. / {team} 누구나 열고 고칠 수 있어요. |
| `folderAccess.hintExcept` (a second sentence) | People set to No access can't. | '열 수 없음'으로 둔 사람은 못 열어요. |
| `folderAccess.connectedCopy` | This folder is a copy of another one. Changes made here don't go back to it. | 이 폴더는 다른 폴더의 복사본이에요. 여기서 고친 내용은 원래 폴더로 가지 않아요. |
| `folderAccess.skillsEdit` | People who can edit can change the team's skills. | 고칠 수 있는 사람은 팀 스킬을 바꿀 수 있어요. |
| `folderAccess.willOpen` | {names} will be able to open it | {names}이(가) 열 수 있게 돼요 |
| `folderAccess.willEdit` | {names} will be able to edit it | {names}이(가) 고칠 수 있게 돼요 |
| `folderAccess.willLose` | {names} will no longer be able to open it | {names}은(는) 더 이상 열 수 없어요 |
| `folderAccess.willViewOnly` | {names} will only be able to view it | {names}은(는) 보기만 할 수 있어요 |
| `folderAccess.willLoseSkills` | {names} will no longer be able to change the team's skills | {names}은(는) 팀 스킬을 더 이상 바꿀 수 없어요 |
| `folderAccess.andOthers` | {names} and {n, plural, one {# other} other {# others}} | {names} 외 {n}명 |
| `folderAccess.noChange` | No one's access changes. | 바뀌는 사람이 없어요. |
| `folderAccess.adminsAlways` | Owner and admins can always open team folders. | 팀장과 관리자는 팀 폴더를 언제나 열 수 있어요. |
| `folderAccess.sharedDifferently` | {n, plural, one {# folder inside is} other {# folders inside are}} shared differently | 안에 다르게 공유된 폴더가 {n}곳 있어요 |
| `folderAccess.openInAdmin` | Open in Folder permissions | 폴더 권한에서 열기 |
| `folderAccess.confirmOpen` | Let {n, plural, one {# more person} other {# more people}} open it? | {n}명이 더 열 수 있게 할까요? |
| `folderAccess.confirmEdit` | Let {n, plural, one {# person} other {# people}} edit it? | {n}명이 고칠 수 있게 할까요? |
| `folderAccess.confirmMore` | Give more access? | 더 열어 줄까요? |
| `folderAccess.confirmBelow` | They can also open {n, plural, one {# folder} other {# folders}} inside. | 안의 폴더 {n}곳도 열 수 있게 돼요. |
| `folderAccess.giveAccess` | Give access | 열어 주기 |
| `folderAccess.warnTeamFiles` | {n, plural, one {# person and their AI} other {# people and their AI}} will no longer be able to open {folder}. | {n}명과 그 AI가 더 이상 '{folder}'를 열 수 없어요. |
| `folderAccess.warnSkills` | {n, plural, one {# person and their AI} other {# people and their AI}} will no longer be able to use the team's skills. | {n}명과 그 AI가 더 이상 팀 스킬을 쓸 수 없어요. |
| `folderAccess.warnSkillsEveryone` | Everyone will be able to change the skills every AI follows. | 모든 AI가 따르는 스킬을 누구나 바꿀 수 있게 돼요. |
| `folderAccess.saveAnyway` | Save anyway | 그래도 저장 |
| `folderAccess.staleKept` | Someone else changed this just now. Saving replaces their change. | 방금 다른 사람이 바꿨어요. 저장하면 그 내용을 덮어써요. |
| `folderAccess.staleLoaded` | Someone else changed this just now. | 방금 다른 사람이 바꿨어요. |
| `folderAccess.showTheirs` | Show theirs | 바뀐 내용 보기 |
| `folderAccess.projectFollows` | Who can open it follows the project's members. | 열 수 있는 사람은 프로젝트 멤버를 따라요. |
| `folderAccess.openCount` (members) | {n, plural, one {# person can open it} other {# people can open it}} (owner and admins included) | {n}명이 열 수 있어요 (팀장·관리자 포함) |
| `folderAccess.openCountApart` (admins in projects; #341's role line follows) | {n, plural, one {# person can open it} other {# people can open it}} | {n}명이 열 수 있어요 |
| `folderAccess.switchedOff` | Switched off | 사용 중지됨 |
| `folderAccess.everyoneOpens` (members) | Everyone at {team} can open it | {team} 모두 열 수 있어요 |
| `folderAccess.adminChanges` (members) | An admin changes who can open it. | 열 수 있는 사람은 관리자가 바꿔요. |
| `folderAccess.onlyYouOpen` | Only you can open it. | 나만 열 수 있어요. |

Korean particles after `{names}`/`{group}` stay literal ("이(가)", "은(는)"), as ko.ts writes them today; there is no
particle helper and this plan adds none. Reused: `folderAccess.ownFolder`, #298's project words,
`accessEdit.kind.group` ("Group · 5 people"), `role.member`, `accessEdit.discard*`, `common.done/cancel/save`. Dropped from
the panel (still used by Admin): `accessTree.counts`, `folderAccess.below`, `folderAccess.all`,
`accessTree.editRules/addRules`, `accessEdit.saveLess/More/Both`. The chip keeps its own words (#341).

## Mocks

Admin, "Company-wide" (`shared/`) in the owner's team (`everyone: none`, two folders inside with their own settings):

```
+- Who can open it ------------------------------- x -+
|  Company-wide                                       |
|  [ Add people or groups                          ]  |
|                                                     |
|  No one is added yet.                               |
|                                                     |
|  General access                                     |
|  [ Only people added here                      v ]  |
|  Only the owner and admins can open it.             |
|  -------------------------------------------------  |
|  Owner and admins can always open team folders.     |
|  2 folders inside are shared differently            |
|  Open in Folder permissions                         |
|                                           [ Done ]  |
+-----------------------------------------------------+
```

Admin, "Quotes" (`shared/Sales/Quotes`; set here: Sales can edit, alice can view; on `shared/Sales`: Leads can view and
`everyone: none`), after adding the group Design (4 people, none of whom could open it):

```
+- Who can open it ------------------------------- x -+
|  Quotes                                             |
|  [ Add people or groups                          ]  |
|                                                     |
|  [#] Design                       [Can view v] [x]  |
|      Group · 4 people                               |
|  [#] Sales                        [Can edit v] [x]  |
|      Group · 5 people                               |
|  (A) alice                        [Can view v] [x]  |
|      In Sales, but can only view here               |
|  [#] Leads                              Can view    |  <- grey, whole row opens Sales
|      From the Sales folder · Change there ›         |
|                                                     |
|  General access                                     |
|  [ Same as the Sales folder                    v ]  |
|  Only the people in the list can open it.           |
|  -------------------------------------------------  |
|  Owner and admins can always open team folders.     |
|  Open in Folder permissions                         |
|  -------------------------------------------------  |
|  bob, carol, erin and 1 other will be able to open it |
|                               [ Cancel ] [ Save ]   |
+-----------------------------------------------------+

          +- Let 4 more people open it? -------------+
          |  bob, carol, erin and 1 other will be     |
          |  able to open it.                         |
          |               [ Cancel ] [ Give access ]  |
          +-------------------------------------------+
```

Member, a folder they can write (the phone sheet has the same lines):

```
+- Who can open it ------------------------------- x -+
|  Sales                                              |
|  6 people can open it (owner and admins included)   |
|  An admin changes who can open it.                  |
+-----------------------------------------------------+
```

Phone (390 px), admin, the sheet:

```
+---------------------------------+
|  Who can open it             x  |
|  Quotes                         |
|  [ Add people or groups      ]  |
|  Design        [Can view v] [x] |
|  Group · 4 people               |
|  Sales         [Can edit v] [x] |
|  Group · 5 people               |
|  alice         [Can view v] [x] |
|  In Sales, but can only view    |
|  here                           |
|  Leads                 Can view |
|  From the Sales folder          |
|  Change there ›                 |
|  General access                 |
|  [ Same as the Sales fold… v ]  |
|  Only the people in the list    |
|  can open it.                   |
|  Owner and admins can always    |
|  open team folders.             |
|---------------------------------|
|  bob, carol, erin and 1 other   |
|  will be able to open it        |
|  [ Cancel ]          [ Save ]   |
+---------------------------------+
```

## Coordination

- **#341 (`fix/members-count-apart`)**: its chip stays (the admin chip says "3 people", the role part in its
  accessible name). Its panel part (the headline and role line for admins) is replaced by this design; on a project
  folder the admin's count uses its `split.direct`. Whichever lands second rebases; this branch keeps `chipLabel`,
  `chipText` and `AudienceSplit`.
- **`feat/project-members-only`** (planned; the owner chose it): this panel already treats `projects/<name>/` and
  everything inside as read only, with no admin request there (§4). When that branch lands it changes two things here:
  `footerOf` shows its members-only sentence on project folders, and the count words drop "(owner and admins
  included)" there. No key names are shared (this branch uses `folderAccess.projectFollows`; that branch owns its own).
- **#339 (`feat/phone-page-patterns`)**: `CompactRow` for rows; see "Phones".

## Scope

In: the admin panel (rows, general access, footer, link, editing in place, the two confirms), the member panel's
words and layout, the `useRulesDraft` hook shared with Admin's editor, `everyoneAbove`, the `CreateFolderBody` limit,
five languages, docs.
Out: links or guests; a panel for single files; making someone "No access" in the panel; the full result view in the
panel; editing project folders in the panel; any change to Admin › Folder permissions; anything members learn;
"broadest wins" (open question 1); Admin's words (open question 2); the chip's verb (open question 3).

## Steps (planned as two PRs; built as one, PR #346, at the coordinator's request)

1. **PR 1, the read view** (`feat/drive-like-access`): this plan (first commit); `everyoneAbove` and the
   `CreateFolderBody` limit (server, shared type, docs:api); `FolderSharing.tsx` showing the rows, general access, footer
   and link read only, with [Set rules] kept for editing until PR 2; project folders read only; the member panel words;
   the removals; five languages; DECISIONS entry ("Who can open it, like Drive's Share", amending "who can see a folder,
   in place"); `changes/drive-like-access.md`.
2. **PR 2, editing in place** (`feat/drive-like-access-edit`, stacked): `useRulesDraft` out of `AccessEdit.tsx` (no
   behaviour change there), the add field, selects, ✕, "No access" rows, the General access select, "What will
   happen", Save with the fresh ask, the two confirms, the leave guard, "Change there"; [Set rules] removed;
   docs/for-admins(.ko).md.

## Risks

- **Two editors on one logic.** Mitigation: one hook; `access-edit.spec.ts` runs unchanged on Admin's editor.
- **The confirm is not a boundary.** Only admins can save, and the server checks every save as today. Save, and the
  confirm's button, ask the answer again at once; what changes between that answer and the write (a group grows,
  someone is switched back on) is not covered, as in Admin's editor today; the audit row keeps the rules saved.
- **Deepest wins.** "Only people added here" shuts out what folders above give, and adding a group can lower someone.
  The greyed rows disappear after the answer and "What will happen" names who loses, before Save.
- **Load**: one preview on opening, one per settled change (250 ms, as Admin's editor), one more on Save.
- **More access no one can count yet** (`latentMore`) is checked with made-up members: one per group, one per pair of
  the groups named on the way to the folder and below it, one in all of them. With more than 30 such groups pairs are
  not tried, and a pair that gains can be missed when being in all of them already gave more before the change.
- Five languages; 1440 and 390, light and dark; no migration (highest on dev: 701).

## Tests

- Always: `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; `bun run docs:api` and
  `tests/unit/docs-site.test.ts` (the new field).
- Server: `everyoneAbove` in `tests/unit/access-edit-api.test.ts` (nothing above, a member role row above, an everyone
  rule shadowed for every member by group rules, the top, a draft that sets everyone here); `CreateFolderBody` refuses
  201 rules; every `tests/unit/access-*` file; `tests/security/folder-audience.test.ts` unchanged; a member's 403 from
  edit-preview carries no `everyoneAbove`.
- Web unit (`web/test/unit/folder-access.test.ts`, new `folder-sharing.test.tsx`):
  - rows: a group as one row with its size, rows from above greyed with "From the … folder" / "From the team folder",
    "No access" rows (set here and from above), "In Sales, but …", an empty list, no owner or admin in the add list;
  - general access: the choices per folder (top, connected, `shared/`/`skills/`), each hint, ", except …";
  - "What will happen" from `changes` (open, edit, lose open, view only, skills), names and "and N others";
  - save: the body always has `expectedHash` and the panel's folder id; an answer for another path or older rules never
    enables Save; "Change there" with a draft asks first, then the parent's save uses the parent's id, hash and rules;
  - the confirms: a gain by count; "Everyone · Can edit" when every member is in a group (count 0); a switched-off
    person raised; ✕ on a switched-off person (and on a group with one) where general access gives more; a "No
    access" row raised or removed; `team-files`; Enter and a double click give one confirm and one PUT; a 409 after
    the confirm makes the next Save ask again; a fresh answer that differs needs another click, also from the
    confirm's button;
  - a 409 `folderExists` keeps the draft; a refresh (`accessChanged`) keeps the draft;
  - a member's panel makes no admin request and shows no name or "Can view / Can edit"; a project folder (and inside)
    makes no edit-preview, folder or tree request, from the chip either.
- A copy check in the PR: every new string read against principle 1 in all five languages.
- E2E: `folder-access.spec.ts` (admin: add a group, change a setting, remove, general access, both confirms, cancel with
  a draft, another admin's change, another admin opening the parent between the last answer and Save, "Change there"
  and back, `/files?path=…&access=1` opens with no draft, "Open in Folder permissions" with folder names containing
  `?#&%2F`; member; own folder; project folder; the 390 px sheet), `access-edit.spec.ts`, `access-tree.spec.ts`,
  `project-participants.spec.ts`. PR 2 runs the full web e2e (shared editor logic).
- Screenshots 1440 and 390, light and dark: admin on `shared/`, on a nested folder with rows from above, while
  editing, each confirm; member; project folder.

## Review

Two independent reviewers read the plan and the code (product/UX with an explicit check, "Would a non-developer
understand every word and know what will happen when they change a select?", and security). Every must-fix is
resolved above.

Product/UX, must-fix:

1. "From the Sales folder: Only people added" and "Only people added" looked the same and did different things. →
   "Same as the Sales folder" (its line says what that folder gives) and "Only people added here" (1.3).
2. A change could lower someone without saying who (adding a group beats a person's setting above). → "What will
   happen" names people from `changes`, not counts (1.4); principle 3 says "by name".
3. The confirm's counts mixed "open", "edit" and folders inside. → Separate parts from `changes`; folders inside get
   their own line; the title says open or edit (2).
4. Untrue hints (an empty list, "No access" rows, "No access" from above, Drive's "Access removed" mapping). → The
   owner-and-admins line on an empty list, ", except …", "No access" rows from above shown, the mapping corrected.
5. Project counts included the owner and admins (#341's case). → Admins read #341's split on project folders.
6. Projects: folders inside stayed editable though the owner chose members-only; that branch refuses the admin answers
   there; a key name collided. → `projects/` and inside are read only from PR 1 with no admin request; keys renamed;
   coordination rewritten.
7. Words that failed the non-developer test ("From the Team folder folder", "In Sales, but No access here", "Change",
   "일반 접근", "Your changes are kept", the connected folder's silent "Can edit", the phone's cut select, "Choose who
   can open it" after a choice was made, Korean particles and "보기" next to "· 보기"). → Each replaced in 1.2–1.3, 2
   and the copy table.

Product/UX, second round: #5 was still open (an admin's project count used the "(owner and admins included)" words
with #341's split, which leaves them out) → its own string without the suffix plus #341's role line; #7 had two gaps
("Change there" was never visible; Korean particles are literal in ko.ts, not chosen in code) → "· Change there ›" on
the row, the sentence corrected; one new must-fix (the "except" fragment glued onto a sentence) → a second sentence,
"People set to No access can't." Also taken: "Only the people in the list can open it" when rows come from several
folders up; no "follows the project's members" inside a project, and "Open in Folder permissions" there for admins;
"open" in the team-files warning; "Switched off" as its own key; the Design row in the phone mock.

Product/UX, first round, also taken: one verb ("open") in the panel; plain warnings; "Switched off"; "Can always open and edit it";
no owner or admin in the add list; "Open in Folder permissions"; 44 px greyed rows; the full-height sheet while adding;
the skills line; Notion's "broadest" and Drive's "Access removed" in the references.

Security, must-fix:

1. "Change there" could send one folder's draft to another folder, or count another folder's answer as ready. → The
   body is keyed by path and the answer by path and rules (2); tests for the parent's id, hash and rules.
2. The confirm could rest on an old answer (a folder above or a group changed meanwhile). → Save asks again at once and
   decides from that answer; a different answer needs another click; the remaining window is in Risks.
3. Widening that counts nobody today (everyone editing while every member is in a group; a switched-off person) skipped
   the confirm. → The confirm also compares the draft with the stored rules and `everyoneAbove` (2).

Security, also taken (two rounds): the confirm's button asks again too; ✕ on a switched-off person or a group with
one confirms; the chip makes no admin request in projects either; `folder_exists` as a reason; lines built from
`changes` (before → after); narrowing warnings get their own confirm; rows
from above only from the ready answer, dimmed while waiting; the draft survives a refresh; the folder list read again
after saves and swaps, `folderExists` handled; no admin request on project folders; `everyoneAbove`'s principal id and
its `''` / `null` labels; `CreateFolderBody.rules` limited to 200. The reviewer found no way for a member to learn
anything new.

## Open questions for the owner

1. **Deepest wins.** Adding a group here can lower someone who could edit through a folder above; Drive and Notion
   never do that. Recommended: keep the rule and name those people before Save (this plan). Other options: the panel
   refuses such saves and points to Admin, or access becomes "broadest wins" (a large change to every permission).
2. **One vocabulary.** Admin › Folder permissions still says "Basic access", "Read", "Read & write". Recommended: a
   follow-up PR moves Admin to "General access", "Can view", "Can edit".
3. **The chip's verb.** The chip says "N명이 봐요" (#306, #341); the panel says "열 수 있어요". Recommended: the chip
   moves to "open" after #341 lands.

## Result

Built in one PR, #346 (`feat/drive-like-access`). The owner chose option A for open question 1 (the deepest folder
wins, as today; the panel names who loses access before Save); Admin's words move to "Can view / Can edit" in a later
PR; the chip stays the count (#341). The panel title is "Who can open it" / "열 수 있는 사람" in all five languages.

What differs from the plan, and why:
- **When Save asks** comes only from the server's answer. The plan's local comparison of settings (`raisesAccess`) was
  built and dropped after the product review: it asked "Give more access?" for a change that only lowered someone. In
  its place the edit preview has `latentMore` (the security review's finding: switched-off people, whoever joins an
  empty group or the team later, an "everyone" that counts nobody today), checked with the permission function for
  each of them before and after, at the folder and its rule folders below.
- **The footer** (what will happen and the buttons) is the Modal's own footer slot, not a sticky bar in the body (it
  covered the last link and left a gap).
- **Project folders**: the admin count shows without #341's role line (the footer says the owner and admins can always
  open team folders).
- "Same as the folder above" for a folder in `groups/`, `projects/` or `connected/` (no disk name on screen); "Change in
  Sales" for the general access link; Korean names joined with commas.
- The security review's other fixes: after a save the draft starts from the re-read rules; leaving during Save stops
  it; a row made meanwhile is saved over with PUT; the folder row by its exact path; two clicks are one Save.
- #339 (shared phone rows) was not merged: the panel uses the app's bottom sheet with 44 px controls; `CompactRow` when
  it lands.
- Hands-on QA: Admin › Folder permissions' Save button said "1 person loses access" for read & write → read. Its Save
  button and change summary now keep the outcomes apart ("can no longer open it / can no longer edit / can now open it
  / can now edit"), and the panel's line says "…will no longer be able to edit it".
- The confirm names who gains unseen (`latent` on the preview: people switched off, the groups, whoever joins the team),
  and the check includes pairs of groups (second review rounds).
