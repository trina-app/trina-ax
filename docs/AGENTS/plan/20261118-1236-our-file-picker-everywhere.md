# Phones: adding a file always starts from our sheet

- Date (UTC): 2026-11-18 12:36
- Branch: `fix/our-file-picker-everywhere`
- Status: in progress
- Where: trina-ax web/src (Team AX core). Why: the attach sheet and every upload button are core web UI.
- Version impact: patch, phones showed iOS's raw English menu where the app has its own sheet

## Goal

On an iPhone, Files › 내 파일 › ⊕ › 올리기 opened iOS's raw "Photo Library / Take Photo or Video / Choose Files" menu
(English, from a bare file input that names no type), not the sheet the message boxes have (사진 보관함, 사진 찍기, 파일).
Every place on a phone where a person adds a file or a picture starts from our localized sheet, each row opening one
picker of the phone.

## Scope

In: one shared hook for the sheet's device rows (components/DevicePick.tsx, taken out of chat/AttachSheet.tsx), used by
the attach sheet and on phones by: Files ⊕ and an empty folder's 올리기, profile photo (Settings), the member welcome's
photo, the team logo (admin), a room app's icon, the welcome's files and the team-files step's "파일 직접 올리기".
Out: computers (a labelled button opening the computer's own file window is the expected path; no pre-menu there);
iPads at 768px and wider (the computer layout); pickers that name a non-picture type (they open the Files browser
directly on iOS: Drive key .json, .trinaplugin); folder pickers (computers only).

## Steps

1. components/DevicePick.tsx: useDevicePick (rows + hidden inputs + the phone app's photo picker), PhonePickButton.
2. AttachSheet on the hook (same rows, test ids and behaviour).
3. Each place above on phones.
4. e2e (390 + 1440): Files ⊕, profile photo, team logo; unit test for the rows.

## Decisions

docs/decisions/20261118-our-file-picker-everywhere.md.

## Risks

Phone e2e that clicked 올리기 / the photo button and waited for a file chooser now go through a sheet row. No
migration, no server change. Five languages: existing keys only.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, touched unit + e2e specs, `bun run check:prepush`.

## Result

(filled in at the end)
