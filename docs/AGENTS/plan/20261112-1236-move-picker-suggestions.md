# Move picker: suggested and recent folders (no AI call)

- Date (UTC): 2026-11-12 12:36
- Branch: `feat/move-picker-suggestions`
- Status: in progress
- Where: Team AX core (`server/src/team-files/move-suggest.ts`, `server/src/file-list/service.ts`,
  `shared/src/api/files.ts`, `web/src/components/FolderPicker.tsx`, Files). Why: files and the file screen are core
  (docs/REPOSITORY-RULES.md).
- Version impact: minor, two new endpoints and a new section in the Move picker; nothing removed.

## Goal

Files onboarding plan, PR C (owner, 2026-11-12, option 1): after setup, when anyone moves a file, the Move picker
suggests where it goes. "추천" (1–3 folders, each with ✕), then "최근" (folders this person recently moved or saved
into), then the folder browser as today. No popup at upload, no AI call.

## Scope

In:
- `POST /api/files/move-suggestions {paths}` → `{suggested: [{path, confidence}], recent: [{path}]}`. Candidates: the
  folders the person can write, found by a bounded walk of what they can see (`siblingVisible`), not skills, not the
  root containers, not where the files are now. Score: the file's name tokens (+ its own file-list line when it shows
  for them) against each folder's name, its direct files' names and their file-list lines (only lines the person's
  `_FILES.md` would show), idf-weighted overlap; the Dropbox finding (name similarity beats ML). Threshold 0.5: none
  rather than a weak guess; at most 3, each at least 60% of the best.
- Recent: `file_events` of this person (moves in, uploads, saves; existing rows, no new storage), folders they can
  still write, at most 3.
- `POST /api/files/move-suggestions/dismiss {paths, folder}`: per person, folder and the file's name pattern (digits
  dropped), in `suggestion_dismissals` (migration 229, no new migration).
- Web: the two sections on top of `FolderPicker` for Move (single and bulk), a suggestion row selects that folder, ✕
  hides it; keyboard reachable; 390 px and dark.

Out: the setup step's AI plan (PR A), forms (PR B), suggestions in Share or Save pickers, learning from accepted picks.

## Steps

1. Shared contract + `bun run docs:api`.
2. Server module, file list `visibleFields` helper, routes.
3. FolderPicker sections, Files wiring, i18n ×5.
4. Tests: server unit (scoring, permissions, threshold, empty file list, dismiss, recent), web unit, e2e (mock server).
5. DECISIONS entry, `changes/move-picker-suggestions.md`.

## Risks

- Leaks: a suggestion only names a folder the person can write; scores read only names the person can see and lines
  their `_FILES.md` would show (the view's checks). A member sees nothing about folders they cannot write.
- Cost: walk capped (folders and files per folder), no model call; the request runs in the person's own time.
