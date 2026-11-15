# Find work files: a button in the Files toolbar

- Date (UTC): 2026-11-15 16:00
- Branch: `fix/find-work-files-toolbar`
- Status: done
- Where: trina-ax (Team AX core: web Files page). Why: the entry is part of the core My files screen (see docs/REPOSITORY-RULES.md)
- Version impact: patch, one control moves

## Goal

Owner: the "Find work files on this computer" line sat in a weird place (a loose line between the breadcrumb and the
list). It becomes one normal toolbar button beside Upload folder and Upload.

## Scope

In:
- `FindWorkFilesEntry` renders a ghost small Button (FolderSearch icon, label "Find work files", new key
  `files.findWork.entryButton` in 6 locales), placed in the Files toolbar. Same visibility as before; icon only in a
  narrow container; still hidden at phone width. The dialog and its result (Added N files, Open, Undo) are unchanged.
- The loose line is removed; the guide text and the e2e text follow.

Out: the dialog internals and ranking, the welcome step's own button and its label.

## Steps

1. Move the entry, add the key, update the e2e text and the guide.
2. Screenshots 1440/900/390, light and dark, before and after; typecheck, i18n, find-work-files e2e.
3. Independent review.
