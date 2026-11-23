# edit_hwp puts a signature or seal image into a Hangul document

- Date (UTC): 2026-11-23 08:43
- Branch: `feat/hwp-insert-image`
- Status: done
- Where: core (`server/src/files`, `server/src/tools`, `shared/src/tools.ts`). Why: Hangul writing is core code behind the
  HWP plugin switch (docs/REPOSITORY-RULES.md).
- Version impact: minor, edit_hwp gets a new kind of change (an image), a new user-visible capability.

## Goal

A person attaches a form ("멘토링 보고서 양식.hwp") and says "여기에 내 사인 좀 넣어줘". Today the AI answers that
edit_hwp changes text only and tells them to do it by hand in Hangul. Make edit_hwp put a PNG/JPEG (a signature, a
seal, transparent PNG kept) into the document at a spot found like the text changes are: over or next to a label such as
"(인)", or in the table cell next to a label ("서명"), with a size in mm, behind or in front of the text. Both .hwpx and
.hwp, everything else in the file byte-identical as today.

## Scope

In:
- A new change `{ image, at | cell, occurrence?, place?, width_mm?, height_mm?, layer? }` in `EditHwpInput`.
  `image`: a team-folder path the person can read (chat attachments are in `.attachments/`), PNG or JPEG, at most
  10 MB, at most 10 images per call. `at`: label text inside one paragraph, `place` "over" (default), "after" or
  "before". `cell`: `{ next_to, direction?, occurrence? }` as for a filled cell; the image is centred in that cell.
  `layer`: "behind" the text (default, 글 뒤로) or "front".
- Placement: the label's position on the page comes from the HWP renderer's layout (`rhwp export-render-tree` and
  `dump-pages`, a new read-only engine call next to `export-png`, same isolation, preflight and limits). The worker
  matches the n-th occurrence the document model finds with the n-th one the layout shows (counts and the line's text
  must agree, else refused), and places a floating picture relative to the paper at that spot, anchored at the end of a
  body paragraph on that page (see the decision file for why). Nothing else on the page moves.
- .hwpx: the image as a new zip part `BinData/imageN.(png|jpg)`, an `opf:item` in `Contents/content.hpf`, an `hp:pic`
  inside the paragraph's run (Hangul's element order). Every other part copied with its compressed bytes.
- .hwp: a new stream `BinData/BIN%04X.(png|jpg)` (raw-deflated when the document is compressed), a BIN_DATA record and
  the ID_MAPPINGS count in DocInfo, the 8-WCHAR `gso ` control in PARA_TEXT, CTRL_HEADER + SHAPE_COMPONENT +
  SHAPE_COMPONENT_PICTURE records in the paragraph (record layouts from Hancom's HWP 5.0 document, checked against the
  pinned rhwp's own insert-image output). `files/cfb.ts` learns to add a stream (and the BinData storage) to the
  directory tree.
- Checks: the server-side read-back allows exactly the new picture parts (their bytes must be the image bytes) and, when
  there are images, `content.hpf` / `DocInfo`; text read-back unchanged for image changes; the fresh-worker verify
  passes; the tool result tells the AI to look at the page with hwp_render. Before/after renders compared in tests.
- Prompt: edit_hwp description and EDIT_HWP_RULE say it puts signatures and seals in; with no image the AI asks the
  person to attach one.
- Why "PDF로 바꿔서 도장" did not work: the engine exposes only one PNG page (no PDF export); answered in the PR. With
  the image going into the Hangul file itself the fallback is not needed.

Out: images in headers/footers, nested tables as cell targets, explicit page coordinates, rotating or cropping,
replacing an existing picture, HWP → PDF export.

## Steps

1. Plan (this file), independent plan review, QA rows.
2. `shared/src/tools.ts`: the image change in `EditHwpChange`; `hwpx-check.ts` `HwpChange`, request framing with images
   and the layout, report `pictures`.
3. `hwp-engine.ts`: `layout()` (render tree → compact lines and cells per page); `hwp-layout.ts`: parsing and
   matching, placement maths (shared by both formats).
4. `hwp-changes.ts`: find the label / cell for an image change (shared), call the format's `pictureAt`.
5. `hwpx-edit.ts`: zip part, manifest item, `hp:pic`. `hwp-edit.ts` + `cfb.ts`: stream, DocInfo, records.
6. `hwpx-check.ts` read-back for pictures; `tools/edit-hwp.ts`: authorize, read and check images, call layout, result
   text; `tools/index.ts` description; `chat/prompt.ts`.
7. Tests: unit tests for both formats with a fake form (no customer documents), cfb add-stream, read-back refusals,
   access refusals; render before/after with the pinned rhwp where present.
8. Decision file, changes/ note, PR into dev.

## Decisions

- `docs/decisions/20261123-hwp-insert-image.md`: the editors stay core code, but placing an image reads the page
  layout from the renderer (read-only render tree), so an image change needs the HWP renderer to run on the server;
  without it the change is refused with the reason (text changes are unaffected).

## Risks

- Hangul's reading of our picture records (no Hangul here): mirror the pinned rhwp's output, render with rhwp, try the
  Hancom Docs web check if the session allows.
- Layout differences between rhwp and Hangul move the image by a few mm: the result tells the AI to look at the page.
- Security: the image is read with the person's read permission (authorize), size-capped, PNG/JPEG magic checked, the
  quarantine check as for stamp_pdf; no URLs (no SSRF), the new file goes through the wider-audience check with the
  image as a source. The render tree is the renderer's output: parsed with caps, data only.
- No migration, no i18n strings (server text is English for the AI).

## Tests

`bun run typecheck`, `bun test tests/unit/hwp*`, `tests/unit/cfb*`, tool-list tests, `bun run check:prepush`.

## Result

Built as planned, with two changes found while testing with the renderer and Hancom Docs: the picture is anchored at the
end of a body paragraph (not before the label, and never inside a cell: a cell grows around it), and it is placed from
the paper, not from the paragraph (the renderer collapses a paragraph with a behind-text picture placed from it). Hancom
Docs opens both formats with both pictures; on the renderer-made test form the picture sat one line higher in Hancom,
because Hancom wraps an earlier paragraph differently (decision file: limit). Decision:
docs/decisions/20261123-hwp-insert-image.md. HWP to PDF is not available (the engine only draws PNG pages).
