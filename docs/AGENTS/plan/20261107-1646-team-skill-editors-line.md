# Team skills line: count folders with their own editors, fewer requests, no blank line

- Date (UTC): 2026-11-07 16:46
- Branch: `fix/team-skill-editors-line`
- Status: in progress
- Where: trina-ax core (`web/src/pages/admin/SkillManagers.tsx`, `web/src/lib/access-view.ts`, i18n). Why: follow-up to
  PR #176 (team skills are core; see docs/REPOSITORY-RULES.md)
- Version impact: patch. It fixes the wording of the Team skills line; no API or rule change.

## Goal

The "고칠 수 있는 사람" line on the Team skills page (owner and admins) has three problems:

- It counts people who can edit only a subfolder of `skills/`, but only from person and group rules. An "everyone:
  write" rule on `skills/재무` alone is missed, so the line says "팀장과 관리자만" while every member can edit there.
- One failed request blanks the whole line, with no way to retry.
- Every page load sends one request per subfolder, each paging through all people, and [바꾸기] sends them all again.

## Scope

In:
- Read the folder rules once (`GET /api/admin/folders`, the list Folder permissions uses). Count the folders inside
  `skills/` whose rules give write to anyone beyond the owner and admins: everyone, the old members row, groups and
  people. End the line with that folder count ("폴더별로 맡긴 곳 N개", en "N folders have their own editors"). It
  replaces the people count, so there is no per-folder request.
- If the rules fail to load, show the base line without "만" or "only". If the base line fails, show "불러오지 못했어요"
  with a retry button.
- [바꾸기] reloads only the `skills/` answer the dialog uses, not the folder rules.
- Nits: focus after a removal only moves once the fresh list is on screen, never while the search box has focus, and
  never after a failed reload. ko `offTitle` no longer puts a particle after the name.

Out: any server change.

## Steps

1. `SkillManagers.tsx`: split the line's loads (`skills/` answer; folder rules), drop the per-folder fan-out, add the
   retry, make [바꾸기] reload only the `skills/` answer, and fix the focus handling.
2. `access-view.ts`: `skillEditorsText(…, byFolder)` takes a folder count, or `null` when it is not known.
3. i18n in five languages, unit tests, e2e for an everyone rule on a subfolder and for failed requests; docs wording.

## Risks

None for permissions: the change is read-only. The five app languages need the new texts.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, the skill-manager and access
`tests/unit` files, `bun run build:web` and the full web e2e.

## Result

Filled in at the end.
