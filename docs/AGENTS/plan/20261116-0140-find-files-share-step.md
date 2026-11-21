# Find work files: a step to share some of the added files with the team

- Date (UTC): 2026-11-16 01:40
- Branch: `feat/find-files-share-step`
- Status: done
- Where: trina-ax (Team AX core: web onboarding / My files dialog). Why: Find work files and file share links are core
  screens (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new step in an existing flow (no API, no migration)

## Goal

Owner, 2026-11-16: "<product> finds files that are good to share with your team." In Find work files on this computer
(My files, and the invited person's welcome card on Home), after the files the person ticked are added to My files ›
From this computer, one step lets them pick which of those to share with teammates. Until now they stayed private and
sharing meant opening each file's Share dialog.

## Scope

In:
- One step in the same dialog, after the add run is done (at least one file landed): the added files as a list with
  boxes (nothing ticked), the file Share dialog's own people-and-groups search (who sees them), ONE primary button
  "Share n files", and "Not now". A small hint "Often shared · Form" on the files whose kind teams usually share
  (form, company intro, brand, policy, training, minutes), from the AI's own pick reason of the list before, else the
  name rules (`nameReason`). Never pre-ticked.
- Sharing calls the existing `PUT /api/files/shares` per file (same rules, limits and refusals as the Share dialog:
  only own files, members only while "Members can share files they own" is on, at most 50 people and groups, a member
  only their own groups, never a guest). A 429 waits the server's `retryAfter` and tries again.
- After Share or Not now: the run's result as before (Added n files, Undo, Open, Close) with one line "Shared n files
  with Sales" and a quiet "Share with your team" link back to the step (the way back from Not now).
- Skipped by itself when the person may not share (team switch off: `GET /api/files/shares` says `off`).
- Welcome card: unchanged rules (the row is done once a file landed); the dialog closing reloads the card.
- en first, then ko, id, ja, es, zh. User doc (en + the five translations' pages get the new section), docs/decisions/20261116-find-files-share-step.md,
  `changes/find-files-share-step.md`.

Out:
- A one-press "whole team" (no such subject on file shares: it would be a new permission path; asked as an open
  question). The owner's setup 팀 파일 step (its files already go to the team home).
- A new AI call for the hint (the add list's AI picks and the name rules are used), the chat ShareWarning (it is about
  chat answers; a file share widens nothing else), batching the recipients' notices (one per file, as the Share dialog).

## Steps

1. `web/src/components/onboarding/ShareFoundFiles.tsx` (the step) and its wiring in `FindWorkFiles.tsx` (onAdd passes
   the reasons; RunResult stages: share → result).
2. Keys in six tables; unit test for the hint and the share loop; e2e in `find-work-files.spec.ts`.
3. Docs, decision, changes fragment; screenshots 1440/390 light/dark, member/admin/owner.
4. Checks: typecheck, check:i18n, check:docs, web unit, targeted e2e.

## Risks

- Rate limit: the room send budget (20 at once, then 1 a second) also counts shares; up to 100 files wait and retry.
- Notices: each shared file is one Activity notice per recipient (as with the Share dialog).
- No migration, no endpoint.

## Result

Built as planned: `ShareFoundFiles.tsx` (the step), `lib/shareFound.ts` (hint and the per-file share with 429
retries), RunResult stages check → share → result in `FindWorkFiles.tsx`. Decision:
docs/decisions/20261116-find-files-share-step.md. No endpoint, no migration. Open question for the owner: a one-press
"whole team" share needs an everyone subject on file shares (a new permission path), not built.
