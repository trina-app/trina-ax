# Add, move and resize a picture in PowerPoint and Excel

- Date (UTC): 2026-11-23 23:40
- Branch: `feat/office-place-picture`
- Status: in progress
- Where: `server/src/files`, `server/src/tools/edit-office.ts`. Why: edit_office is the one path for changing an Office file.
- Version impact: minor, because edit_office can add and move pictures in two more formats.

## Goal

The owner asked why a picture cannot be added to Excel and PowerPoint. This is the first slice of general picture
placement: place, look, move.

## Scope

In:
- `insert_picture` for .pptx (slide + `x_mm`/`y_mm`, or centred) and .xlsx (sheet + cell, optional offset), with
  width and height.
- `move_picture` for .pptx and .xlsx: move or resize a picture the file already has, by name or number.
- After a deck edit the result says which slide to read as an image. After a workbook edit it says no view was drawn.

Out: Word and Hangul keep their current paths (they can take the same `insert_picture` / `move_picture` shape later).
No mm gates, forgery checks, mark rules or extra modes.

## Steps

1. A small shared size helper; `insert_picture` and `move_picture` in `pptx-edit.ts` and `xlsx-edit.ts`.
2. Tool schema, allowed parts, read-back of the package (relationships, content types, unique ids).
3. Focused tests; open real files in LibreOffice.

## Decisions

- Same op name as Word's `insert_picture`, so the card, Always, read access and re-encoding stay one path.
- A refusal happens only when the slide, sheet, cell or picture cannot be found, and it lists the choices.
- A workbook edit with only pictures does not force a recalculation.

## Validation

Typecheck, affected suites, `check:prepush` on Bun 1.3.12, a real deck and workbook opened in LibreOffice.

## Result

Not done yet.
