# Setup 팀 파일: the AI reads the uploaded files and proposes folders in 전사 공유; project grouping; an admin row

- Date (UTC): 2026-11-12 12:38
- Branch: `feat/setup-files-organize`
- Status: done
- Where: trina-ax core (`server/src/onboarding/`, `shared/src/api/onboarding-files.ts`, `shared/src/files-organize.ts`,
  `web/src/components/onboarding/`, member welcome). Why: onboarding, files and the AI are core (docs/REPOSITORY-RULES.md).
- Version impact: minor (new API routes, a new screen in the setup step; no migration)

## Goal

The owner's ask (2026-11-12, locked plan "Files onboarding — final plan", PR A): setup must lead the team lead to put
the team's files in and the AI organizes them. At setup there is no folder structure, so the AI proposes one: which
folders under 전사 공유 (shared/), and which file goes where. The owner looks at one list, changes or removes rows, and
presses [이대로 정리]. When the AI sees a group of files about one engagement it asks once to make it a project. Admins
who join later get one row "팀 파일 정리하기" on their welcome card until a plan was applied.

## Scope

In:
- After the 팀 파일 step's upload run into shared/ lands: "읽고 정리하는 중… n/N". The server reads the text of at most
  20 files (extract.ts, 3,000 characters each) as the caller and makes ONE no-tools turn of the caller (the file-rank
  path: their AI access and budget) that returns folders (≤ 8, one level under shared/, existing ones reused first),
  each file's folder, reason word and `form: true|false`, and at most one project group. Files beyond 20, and every
  file when there is no AI, a failure or a timeout, go by name rules (the file-rank reason words). The organize answer
  carries `form` per file for PR B.
- The proposal: a flat list grouped by folder ("전사 공유 › 양식 (3)"); per row change the folder (proposed + existing
  folders, or a new one) or remove it (it stays where it was uploaded); a new folder's name is editable inline;
  [이대로 정리] and "나중에". Nothing matched: no list, the step's end as today.
- [이대로 정리]: the server applies the moves as the caller (the file service's move: rules, versions, events), makes the
  folders, removes folders the moves left empty, records that a plan was applied. The result screen: a slot for PR B's
  forms card (empty here), the project question "이 n개는 'A사 리뉴얼' 프로젝트로 묶을까요?" [프로젝트로 묶기] / 나중에
  (a team project with the setup's team group as participant, its files moved into projects/<slug>/), and the next step.
- The F1 line "팀 전체가 보는 전사 공유에 정리해 드려요 · AI가 파일 내용을 읽고 정리해요" (the W6 "no content" rule is
  reversed for this step, said on screen and in DECISIONS).
- Member welcome: `organizeFiles` on the card for admins while no plan was applied; the row opens the same step in a
  dialog.
- i18n ×5, DECISIONS entry, changes fragment, API docs, unit tests (server + web), e2e with the mock server.

Out: PR B (forms → skills), PR C (Move picker suggestions).

## Steps

1. Shared contract (organize start/status/apply, plan shape) and the pure name rules + plan builder in
   `shared/src/files-organize.ts` (the server and the mock use the same rules).
2. Server: generalize file-rank's turn runner; `onboarding/files-organize.ts` (read, prompt, parse, cap, fallback, job
   with progress, apply, applied flag); routes; member welcome field.
3. Web: the organize screens in the 팀 파일 step after the run; the admin row; i18n.
4. Tests, docs, changes; checks.

## Risks

- Privacy: file content now reaches the caller's AI provider during setup (only files they just uploaded and can read;
  ≤ 20 × 3,000 characters). Said on screen and in DECISIONS.
- Moves after upload: rules of the file service apply; a name taken in the target gets " (2)"; a failed move leaves the
  file where it was and is counted.
- No migration: the plan's applied mark is a settings row; the turn reuses `onboarding_file_ranks` (its material JSON
  gets a `kind`).

## Result

Built as planned (docs/DECISIONS.md "Setup 팀 파일: the AI proposes folders"). Differences: the plan is a job the page
polls (start + status) so the progress line is real; the admins' row hides once any owner or admin applied a plan; the
project is made by the page through the existing projects and move APIs (`projectBody` gives the team group); "나중에"
on the proposal goes on to the next step (the run's end screen shows when coming back).
