# edit_hwp places a picture from the renderer's page layout

- Date: 2026-11-23
- Status: accepted
- Supersedes: none
- Branch: feat/hwp-insert-image (the owner: "이거를 왜 못하지?" after the AI could not sign a .hwp form)

- **Ask:** "여기에 내 사인 좀 넣어줘" on a Hangul form: put the person's signature or seal image into the document, as
  Claude Code would, instead of telling them to do it by hand.
- **Rule:** edit_hwp takes an image change `{ image, at | cell, place, width_mm, height_mm, layer }`. The editors stay core
  code and keep every byte they do not need to change. Where the picture goes comes from the HWP renderer's page layout
  (rhwp `export-render-tree` and `dump-pages`, read-only, the preview's isolation, limits and turn-taking): the label
  found in the document is paired with the same occurrence in the layout (counts and the line's text must agree, else
  refused). The picture floats behind the text by default, its control at the END of a body paragraph (never in a cell:
  a cell grows around it), so no text moves.
- **Two vertical anchors, by what the document stores:**
  - Every paragraph of the section has a layout cache (PARA_LINE_SEG / hp:linesegarray, which Hangul desktop writes):
    the renderer follows the stored line positions (measured: moving a stored vpos moves the line), so the picture is
    placed from the paper and the preview shows it on the spot.
  - Any paragraph without one (Hancom Docs web saves none): Hangul wraps by itself and can differ from the renderer by a
    line above the label (measured: 5 mm). The picture is placed from the top of the label's body paragraph; for a place
    in a table, from the body paragraph after the table, because Hangul measures a table's own paragraph from below it.
- **Measured in Hancom Docs** on made-up forms Hancom saved, through the whole tool path: vertical 0.0 to 0.5 mm on the
  three seals measured over body text (seals in a table were checked by eye); horizontal 1.1 to 1.7 mm to the left of "(인)" (the renderer's line is a little narrower than Hancom's). No
  correction factor was added: the error does not follow one rule across these few lines.
- **Known limits:** with the paragraph anchor the pinned renderer draws the NEXT text line one line too high, over the
  label's line, so Trina's preview of such a document looks wrong while the file is right. The paper anchor on a real
  Hangul desktop file is not checked in Hangul itself (none is available here). hwp_render is that same renderer, so the
  tool result does not call it a check of Hangul.
- **Security:** the picture is a team file the person may read (authorize, as stamp_pdf), or a file of this chat through its
  own open; at most 10 MB each, 20 MB per call as read and as re-encoded, 10 per call, PNG or JPEG by its bytes, at most
  8000 px a side, not quarantined, and a source of the result even
  for a new version (confirmSources). No URL is taken. The isolated image helper re-encodes it (upright, no details) and the
  worker keeps only the chunks or segments that draw it. The AI uses the person's own signature or seal or the one they
  name, never someone else's on its own. The server allows exactly the new parts; the fresh verify worker
  compares old and new (DocInfo / content.hpf only gained the pictures' entries, each part a clean picture, each new
  picture shows a new entry). The render tree is parsed with caps and checked numbers.
- **Left out:** a Hangul DOCUMENT that is itself a chat file (a shared chat's attachment; edit_hwp takes team paths), pictures in headers or footers, nested tables as targets, explicit page coordinates, HWP to PDF (the
  engine only draws PNG pages; with the picture in the Hangul file itself the PDF detour is not needed).
- **Needs:** the HWP Preview renderer running on the server; without it an image change is refused with that reason and
  text changes work as before.
- **Version impact:** minor (a new capability of edit_hwp).
