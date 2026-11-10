# Project members: one panel on the project page and the list card

- Date (UTC): 2026-11-10 01:57
- Branch: `feat/project-members-panel`
- Status: done
- Where: trina-ax core (`web/src/`, one field in `server/src/routes/chats.ts` and `server/src/chat/project-access.ts`,
  `shared/src/api/`). Why: projects and permissions are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A visible change to where members are changed, two optional response fields; no migration.

## Goal

The owner (2026-11-10): "프로젝트 탭의 각각 프로젝트에서 좀 쉽게 멤버 권한을 바꿀 수 있으면 좋을것 같은데?" Today the
members of a team project ("참여 대상") are three clicks away (card, the name's menu, 수정), mixed into a dialog with
the name, the instructions and chat sharing, as a checkbox list of every person and group. This puts them one click
from the project page and the list card, in one small panel. The second part (the AI changes members after a card) is
a separate PR built on this one.

Owner decisions: no 보기/편집 split for now (every member reads and writes, as today).

## Scope

In:
- `Project.membersEditable` (the caller can change its members: `mayEditProject` and `accessEditable`, so a member who
  made an older project on an admin's folder does not get a 관리 that dead-ends) and `Project.creatorChangesMembers`
  (the creator, while their account is active, can change them; the hint below names them only then). Team projects
  only; absent elsewhere and from older servers.
- Project page: a 멤버 row after 파일 in the side column, meta "N명이 봐요" (`Project.audience`). With
  `membersEditable`, 관리 opens the members dialog and the row has nothing to expand. Without it, the row expands to one
  line: "멤버는 {creator}님(만든 사람)이나 관리자가 바꿔요" (the creator only with `creatorChangesMembers`, else
  "멤버는 관리자가 바꿔요"); admins on a project outside `projects/` get the existing legacy note with a link to Admin ›
  Folder permissions. No row for personal projects or a project whose folder is in the trash.
  `/projects/:id?members=1` opens the dialog (the AI's tool links there in the next PR).
- List card ⋯: 멤버 after 이름 바꾸기, only with `membersEditable`; it opens the same dialog without leaving the list.
- `ProjectMembersDialog` (new): the participants part of `ProjectForm`, moved. The edit dialog keeps the name, the
  instructions, chat sharing and the repoint, and saves them with one PATCH.
- The picker (`ParticipantPicker`, shared by create, share and the members dialog) becomes "the members now + search to
  add": the members first (the creator or "나" fixed, people and groups with a rule set in Admin › Folder permissions
  tagged "읽기 · 폴더 권한", without ×), each row the name on one line and then title · tag; × to remove, 되돌리기 on a
  row removed before saving, 새로 on a row added (title kept). Focusing the empty search lists everyone who can be added;
  typing narrows it; the results take the list's place (on a phone sheet too) and 추가 adds. × and 되돌리기 are 44 px
  tap targets on phones.
- The count line only: "9명이 봐요 (팀장·관리자 포함)". The names line ("볼 수 있는 사람: 영업 부서 · …") goes, in all
  three dialogs (the list above it shows the names).
- The confirm (review M4 part A, M6): the dry run (`POST /api/projects/access-preview`) also says when the save adds the
  floor rule (`everyone: none`, a folder older builds made without it) or brings the creator's rule back
  (`addsFloor`, `restoresCreator`, present only when true). The web asks when someone gains it **or** when either is
  set, and the confirm says how many lose it when `removed` is above 0. Narrowing alone still saves at once.
- "참여 대상" is called "멤버" in all five languages.
- Docs: PERMISSIONS.md, for-teams.ko.md, for-teams.md, the DECISIONS entry "Projects live only in projects/" (where
  members are changed), a new DECISIONS entry, CHANGELOG.

Out: a 보기/편집 split; names for members who cannot change the project (they get the count only, as today); a names
list in the side row (cut by the review); a live update of another window's count (right on the next load).

## Steps

1. This plan.
2. Server: the two fields in `projectOut` and the list; `addsFloor` / `restoresCreator` in `previewAccess`; shared types.
3. Web: the picker, `ProjectMembersDialog`, `ProjectForm` without participants, the row and the menu item, `?members=1`,
   five locales. The mock server's projects follow.
4. Docs, DECISIONS, CHANGELOG, `docs:api`.
5. Tests, screenshots at 1440 and 390, light and dark.

## Risks

- Permissions: no new endpoint and no new write. The dialog uses `GET access`, `POST access-preview` and
  `PUT participants` with `expectedHash`, as the edit dialog did. `membersEditable` only hides a button; the server still
  refuses (403 / 409 `project_not_editable`).
- `creatorChangesMembers` tells a member whether the creator's account is active and the folder theirs to change.
  The creator's name is already on every project; their status is shown in the people directory. Accepted.
- Five languages for every new string; the phone sheet (the Modal is a bottom sheet under 640 px).
- Migrations: none (highest on dev: 701).

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api`; `tests/security/project-participants.test.ts`
(`membersEditable` and `creatorChangesMembers` on new, older and legacy projects, for the creator, a member and an
admin; `addsFloor` and `restoresCreator`), the project, chats and rooms suites, the security permission matrix, the
whole `tests/unit` against dev; web unit tests (`project-form`, new `project-members`, `project-list-menu`) and the
project e2e specs (`project-participants`, `project-list-menu`, `project-page`).

## Result

Built as planned (two optional server fields, the members dialog, the 멤버 line and ⋯ 멤버, the reworked picker, the
confirm with `addsFloor` / `restoresCreator`, five languages, docs). Differences from the plan, from the independent
review of this branch: Esc from a result closes the results only; the create and share dialogs hold the picker in a
labelled group instead of a `<label>`; a "no access" rule from Admin is not listed as a member (only in the read-only
box); the keyboard stays on the row after × and 되돌리기; leaving the picker clears the search; the dialogs close when the
page moves to another project; an admin on a project whose folder is missing reads that, with the link to Admin; the
list reads each creator once. The AI's `change_project_members` is the next PR, stacked on this one.

PR: https://github.com/trina-app/trina-ax/pull/298
