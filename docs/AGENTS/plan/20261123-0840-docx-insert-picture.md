# edit_office: put a signature or seal picture into an existing Word document

- Date (UTC): 2026-11-23 08:40
- Branch: `feat/docx-insert-image`
- Status: done
- Where: server (`server/src/tools/edit-office.ts`, `server/src/files/docx-edit.ts`, `server/src/files/office-edit.ts`). Why: edit_office changes Office files in place; this adds one Word change to it (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new thing the AI can do (a new edit_office change)

## Goal

People ask "여기에 내 사인/도장 넣어줘" on a Word form (a contract, an application with "(인)" or "(서명)"). Today the AI
can stamp a PDF (stamp_pdf, edit_pdf stamp_image) and swap a picture in a deck (replace_picture), but it cannot put a
NEW picture into an existing .docx: it has to rebuild the document with make_file (losing its look) or say no. After
this, edit_office puts the picture at the label, and everything else in the document stays byte for byte.

## Scope

In:
- A Word change `insert_picture: { image, after | over | next_to, occurrence?, width_mm?, height_mm?, behind_text? }`:
  - `image`: a PNG, JPEG or WebP the person can read: a team path, or a chat file (`chat:files/<id>/<name>`, read
    through the chat place's one safe open, readPlaceFile). Read and re-encoded exactly as replace_picture's picture
    (isolated image helper `mycel-safeops resize`, 20 MB per picture, countPictureBytes 40 MB per call, quarantine
    check, wider-audience card through confirmSources and the shared chat's card lists).
  - where, found like text changes (exact text of one body paragraph, table cells included; `occurrence` when it is in
    several places; never in a text box, a field, a tracked change):
    - `after: "<text>"`: right after that text, in the same run (the run's `w:t` split at that point when needed;
      the paragraph's text does not change).
    - `over: "<text>"`: floating behind the text, centred on it (a seal over "(인)"): `wp:anchor behindDoc="1"`,
      `wp:wrapNone`, horizontal position relative to the character where the text starts (offset from an estimate of
      the text's width at its run's font size), vertical centred on the line.
    - `next_to: "<text>"`: in the table cell to the right of the cell that holds the text (a form row
      "서명 | ____"), appended to that cell's first paragraph.
  - size: `width_mm` and/or `height_mm` (1-300); the picture keeps its shape (both given: fitted inside that box);
    neither: 20 mm wide, at most 20 mm high.
  - `behind_text: true` floats an `after` / `next_to` picture behind the text too (default inline); `over` is always
    behind the text.
- OOXML written: one `word/media/imageN.(png|jpeg)` part (first free number), one image relationship in
  `word/_rels/document.xml.rels` (a fresh `rIdN` never used in that part), a `<Default Extension>` in
  `[Content_Types].xml` only when the extension has none, a `w:drawing` with `wp:inline` / `wp:anchor` +
  `a:graphic` / `pic:pic` (namespaces declared on the elements themselves, so a document whose root lacks `wp:`,
  `a:`, `pic:` or `r:` still reads), `wp:extent` and `a:ext` in EMU (1 mm = 36000), a `wp:docPr id` one above every
  `wp:docPr` id in the document's text parts (body, headers, footers, notes) and unique within the call.
- edit-office.ts MAY list for .docx: the document's relationships part and `[Content_Types].xml` may change,
  `word/media/imageN.(png|jpeg)` may be added; everything else must keep its compressed bytes as today.
- The fresh-worker read-back for .docx also checks every changed Word part has each `wp:docPr` id once, and every
  `r:embed` of a new picture names an image relationship that exists.
- The tool description: sign/seal asks on a Word form use insert_picture (and still read the document first).
- Shared chat lists (chat/tools.ts card target, rooms/ai-tools.ts namedPaths): `insert_picture.image` beside
  `replace_picture.image`.

Out:
- Excel (a picture anchored at a cell): not cheap. It needs a new drawing part, its relationships, the sheet's
  `<drawing>` element at its exact place in the sheet's schema order, or an anchor added to an existing drawing; and the
  read-back has no check for drawings. Left for later; the description says Excel pictures are not added.
- Pictures in headers or footers, in text boxes, and replacing an existing Word picture.

## Steps

1. Plan (this file), independent plan review, QA rows.
2. docx-edit.ts: `insert_picture` (find, split, drawing XML, media, relationship, content type, docPr ids); the
   editor gets the call's images like the deck editor.
3. office-edit.ts: read-back checks (docPr ids, r:embed). edit-office.ts: schema, one picture reader for
   replace_picture and insert_picture (team path or chat file), MAY list, description.
4. Unit tests (tests/unit/c-edit-office-docx.test.ts, c-edit-office-tool.test.ts): placement, sizes, ids, rels, content
   types, parts byte-identical, refusals (not found, several, text box, tracked, size, wrong kind, Excel/PowerPoint).
5. Render before/after with LibreOffice (fake form, fake seal) and compare: the seal at the label, nothing else moved.
6. Engine prompt pins re-recorded (tool schema text), changes/ note, typecheck, check:prepush, PR into dev.

## Decisions

none (a new change of an existing tool, same rules as replace_picture).

## Risks

- Security: the picture's bytes are untrusted: only the helper's re-encoded PNG/JPEG reaches the document; the size
  caps of replace_picture; read access checked per picture (team rules, or the chat place's readers); the picture is a
  source of the saved file for the wider-audience check. The document is parsed only in the office worker.
- Word strictness: wrong ids or a missing content type make Word "repair" the file; covered by the read-back and
  tests, and checked by rendering.
- `over` positioning is an estimate of the label's width (no layout engine); the render shows where it lands and the
  AI is told to check the result.
- No migration, no UI text, no app languages.

## Tests

`bun run typecheck`, the office edit unit tests, engine-prompt-pin re-recorded, `bun run check:prepush`.

## Result

Built as planned, with the plan review's points: `wp:simplePos` first in an anchor, `name` on docPr and cNvPr; one
media part and relationship per distinct picture of a call; docPr ids scanned in every `word/*.xml`; the read-back
checks only NEW docPr ids (a document that already repeats ids still edits) and that every new `r:embed` is an internal
image relationship to a part this edit added, with a content type; the MAY widening (relationships part changed or
added, content types, `word/media/imageN.(png|jpeg)`) only for a call with insert_picture; namespaces declared on the
picture only when the root does not bind them; a picture file is a team file or `chat:files/` (not `chat:work/`),
quarantine-checked, at most 20 MB, keyed by its resolved place. Differences: `next_to` makes an inline picture smaller
when it is wider than the target cell's set width (dxa), and says so; several matches without `occurrence` are refused
(no `all` for pictures). Rendered with LibreOffice: the `over` seals land on "(인)" and the page is pixel-identical
outside them; inline pictures take room in their line, as expected. Excel pictures: left out (see Scope).
