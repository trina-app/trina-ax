# edit_hwp places a picture from the renderer's page layout

- Date: 2026-11-23
- Status: accepted
- Supersedes: none
- Branch: feat/hwp-insert-image (the owner: "이거를 왜 못하지?" after the AI could not sign a .hwp form)

- **Ask:** "여기에 내 사인 좀 넣어줘" on a Hangul form: put the person's signature or seal image into the document, as
  Claude Code would, instead of telling them to do it by hand.
- **Rule:** edit_hwp takes an image change `{ image, at | cell, place, width_mm, height_mm, layer }`. The editors stay core
  code (files/hwpx-edit.ts, files/hwp-edit.ts) and keep every byte they do not need to change. Where the picture goes
  comes from the HWP renderer's page layout (rhwp `export-render-tree` and `dump-pages`, read-only, the preview's
  isolation, limits and turn-taking): the label found in the document is paired with the same occurrence in the layout
  (counts and the line's text must agree, else refused). The picture floats on the paper (vertical and horizontal from
  the paper, behind the text by default), anchored at the END of a body paragraph on that page: the label's own
  paragraph, or for a place in a table the first body paragraph that starts on that page (a picture anchored in a cell
  makes the cell grow). So no text and no layout cache of the anchor changes, and nothing else moves.
- **Why paper, not paragraph:** the pinned renderer collapses a paragraph that holds a behind-text picture positioned
  from the paragraph, so the preview would show the next table over the label line. From the paper, the preview and
  Hancom Docs both draw the document unchanged except the pictures. Limit: the place is where the renderer laid the
  label out; for a document whose line breaks the renderer gets differently from Hangul (no Hangul layout cache, other
  fonts), the picture can sit one line off in Hangul (seen on a renderer-made test form in Hancom Docs: about 5 mm).
  The tool result tells the AI to look at the page with hwp_render.
- **Security:** the picture is a team file the person may read (authorize, as stamp_pdf), at most 10 MB each, 20 MB per
  call, 10 per call, PNG or JPEG by its bytes, at most 8000 px a side, not quarantined, and a source of the result even
  for a new version (confirmSources). No URL is taken. The worker writes a clean copy (only the chunks or segments that
  draw it: no EXIF, text or bytes after the end). The server allows exactly the new parts; the fresh verify worker
  compares old and new (DocInfo / content.hpf only gained the pictures' entries, each part a clean picture, one more
  picture in the body per part). The render tree is parsed with caps and checked numbers.
- **Left out:** pictures in headers or footers, nested tables as targets, explicit page coordinates, HWP to PDF (the
  engine only draws PNG pages; with the picture in the Hangul file itself the PDF detour is not needed).
- **Needs:** the HWP Preview renderer running on the server; without it an image change is refused with that reason and
  text changes work as before.
- **Version impact:** minor (a new capability of edit_hwp).
