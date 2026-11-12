# New folders, renames and saved files keep Korean names composed (NFC)

- Date (UTC): 2026-11-11 14:53
- Branch: `fix/nfc-folder-names`
- Status: done (PR open)
- Where: trina-ax core (`server/src/team-files/service.ts`, `server/src/team-files/download.ts`; tests; DECISIONS).
  Why: the file names of the core, used by every edition.
- Version impact: patch; same API, a new name is stored composed

## Goal

QA TC-225 (P2): a folder made with a Korean name typed or pasted on a Mac (decomposed, NFD: `보고서` as 6 code points),
or a file renamed that way, keeps the decomposed name on disk and in the API, and a download names it with the
decomposed letters (`filename*=UTF-8''%E1%84%92…`), which Windows shows as split letters. Uploads already store NFC.
After this change every name the server makes from what a person typed is NFC, and a download's file name is NFC
even for a file that already has a decomposed name.

## Cause

`mkdir`, `save` (a new text file), `ensureFolder` and the target of `move` pass the typed path to `authorize()` as it
came. `walk()` finds existing names in either form (exact, then NFC-equal), but a name that does not exist yet is
kept "as typed". Only uploads (`placeUpload`, `sessions.ts`) and `copy` normalize.

## Change

1. Those four turn the typed path to NFC before `authorize()`. Existing folders on the way are still found in either
   form (walk compares NFC), so a folder already stored in NFD keeps working; only the new last name is NFC.
2. A folder or file already stored in NFD: renaming it to the same name stores it in NFC (on a Mac volume the same
   entry is found and renamed, the "Unicode-form rename"; on Linux it was a separate name already). Nothing on disk is
   renamed by itself (folder rules, versions and projects are stored by path; a silent mass rename is not worth the
   risk).
3. `contentDisposition()` names the download in NFC, so Windows shows full syllables for old NFD names too.
4. DECISIONS: the upload note "the server keeps a new folder's name as sent" is now outdated; say what holds.

## Risks

Linux keeps NFC and NFD as two names: a new NFC name next to an existing NFD sibling is now found as that sibling
(exists / near duplicate, the same answer as typing it in NFC before), never a second entry. No migration.

## Tests

Unit (`tests/unit/c-files.test.ts`): mkdir, rename, move into a folder and save with NFD names store NFC; an existing
NFD folder is still found and can be renamed to NFC; the download header is NFC. `bun run typecheck`,
`bun run check:i18n`, `bun run check:docs`.

## Result

Built as planned. The new test in `tests/unit/c-files.test.ts` fails without the change (the API answered the
decomposed name) and passes with it on macOS (APFS keeps the form it is given). `mkdir / move / rename` and the other
c-files cases pass; typecheck, check:i18n, check:docs pass.
