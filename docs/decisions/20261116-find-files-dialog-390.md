# My files' Find work files dialog stays open at phone width

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/find-files-dialog-390 (QA TC-3504)

- **Bug:** the dialog opened from My files' toolbar button lived inside the computer toolbar. The Files page draws a
  different header at phone width (below 768 px), so making the window that narrow unmounted the dialog: it closed and
  its look stopped. From the Home welcome card it stayed.
- **Rule:** the Files page calls `useFindWorkFilesEntry(path)` once; the button goes in the computer toolbar (none at
  phone width, as before), the dialog below both headers, so it is the same dialog at every width and through resizes,
  whatever folder is on screen. It is the app's Modal (a bottom sheet at phone width), as from the welcome card.
- Tests: e2e `find-work-files.spec.ts` "My files' dialog stays open at 390 and through resizes" (fails on dev).
- Version impact: **patch**.
