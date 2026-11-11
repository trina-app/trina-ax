# A version inside a trashed folder asks for the folder first, also for a plain folder

- Date (UTC): 2026-11-11 16:40
- Branch: `fix/version-restore-trashed-folder`
- Status: done (PR open)
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
folder has none, so its trash is not seen. The modal had no 되돌리기 because `history` found the file's folder
missing (`authorize` answers not_found) and left `canRestore` false, without a reason.

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

Built as planned; `history` also handles the missing folder (not_found from `authorize`): the reason is given to
whoever may write the place. Unit: the new case in `c-files` (history, 409 with the folder-first words, nothing made,
then the trash restore and the version restore); `c-files`, `c-history-restore`, `c-version-authors`, `contracts`,
`a-folders-keep`, `access-explain-api` pass. Local dev server (WebKit): the history modal shows the note and no
되돌리기; `POST /api/files/restore` answers 409 "이 버전의 폴더가 휴지통에 있어요. …".
