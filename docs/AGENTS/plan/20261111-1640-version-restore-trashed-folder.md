# A version inside a trashed folder asks for the folder first, also for a plain folder

- Date (UTC): 2026-11-11 16:40
- Branch: `fix/version-restore-trashed-folder`
- Status: in progress
- Where: trina-ax core (`server/src/team-files/service.ts`, `shared/src/api/files.ts`, the history modal in
  `web/src/pages/Files.tsx`, i18n; tests). Why: file versions of the core.
- Version impact: patch; one optional field in the history answer, a refusal that already existed for rule folders

## Goal

QA TC-229 (P3): a plain folder (no rules) with a file saved 3 times goes to the trash. The file's history lists the
versions with only a download icon, no 되돌리기 and no reason; `POST /api/files/restore` still answers 200 and makes
`shared/Proj/note.txt` again outside the trash (the trash restore then becomes "Proj (restored)"). Expected: the
restore is refused with "restore the folder from the trash first", and the history says why 되돌리기 is missing.

## Cause

`versionInTrash` looks only at the version's `folders` row (`folder_id`, the nearest folder with a row). A plain
folder has none, so its trash is not seen. (The modal hides 되돌리기 because the restore check in `history`
fails for other reasons in the QA case, but says nothing.)

## Change

1. `placeInTrash(segs)`: the file's folder is not there and a trashed folder (`trash_items`, kind folder, not
   restored) is above the path. `restoreVersion` refuses it with the existing `folderInTrash` conflict (the same
   words as for a rule folder); `history` answers `canRestore: false` and `restoreBlocked: 'folderInTrash'`
   (also for a rule folder in the trash), only when the person could restore otherwise.
2. A folder made again under the same name: the file's folder is there, so a version can be restored into it (as now).
3. History modal: a short note "이 파일의 폴더가 휴지통에 있어요. 휴지통에서 폴더를 먼저 되돌리면 버전을 되돌릴 수 있어요."
   (five languages) when `restoreBlocked` says so. Only the modal (another session reworks the Files list layout).

## Tests

Unit (`tests/unit/c-files.test.ts` history): plain folder trashed → history `restoreBlocked`, restore 409 and no file
made; after the trash restore the version restores. Web unit/e2e for the note if one covers the modal.
`bun run typecheck`, `check:i18n`, `check:docs`.

## Result

(filled in at the end)
