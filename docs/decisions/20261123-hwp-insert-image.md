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
- **Where the picture's control goes, by what the document stores:**
  - Every paragraph of the section has a layout cache (Hangul desktop writes one): placed from the paper. In body text the
    control goes at the end of the label's paragraph. For a place in a table it goes into a plain body paragraph on that
    page, never the paragraph that holds a table (on a government form Hancom then moved the page-filling table or the
    picture to another page). A page that is one table has no such paragraph: the control goes into the cell.
  - Any paragraph without a cache (Hancom Docs web saves none): Hangul wraps by itself and can differ from the renderer by
    a line (measured: 5 mm), so the picture is placed from the top of the label's paragraph, or of the paragraph after its
    table.
- **Layer:** behind body text, in front in a table by default: filled cells hid or cut off a picture behind the text.
- **Measured in Hancom Docs:** forms Hancom saved: vertical 0.0 to 0.5 mm, horizontal 1.1 to 1.7 mm left of "(인)". Two
  public government forms saved by Hangul: on the label's line, nothing moved, 1.3 and 2.8 mm left of the centre of the
  longer mark "(서명 또는 인)", whose last word a 15 mm seal then misses; so the tool description tells the AI to give only
  the mark's last characters, and with those the seal covers "인" on both forms. No correction factor was added.
- **Known limits:** with the paragraph anchor the renderer draws the next text line over the label's line, and on a page
  that is one table it draws a row a little taller; the file is right in Hancom. Eight attribute variants did not change
  the first. hwp_render is that renderer, so the tool result does not treat it as proof of the spot. The renderer's
  LAYOUT_OVERFLOW note no longer blocks a preview. Hangul desktop itself was not available; the forms it saved were opened
  in Hancom Docs.
- **Whose picture:** one that is not the asker's own needs their yes on a card; with nobody to ask it is refused
  (tools/own-picture.ts). Where a file lies does not show who put it there (the AI can copy a seal into the asker's folder),
  so until #448's shared origin helper lands every picture gets the card; `ownPicture.is` is the one place to swap.
- **Security:** the picture is a team file the person may read (authorize, as stamp_pdf), or a file of this chat through its
  own open; at most 10 MB each, 20 MB per call as read and as re-encoded, 10 per call, PNG or JPEG by its bytes, at most
  8000 px a side, not quarantined, and a source of the result even
  for a new version (confirmSources). No URL is taken. The isolated image helper re-encodes it (upright, no details) and the
  worker keeps only the chunks or segments that draw it. The AI uses the person's own signature or seal or the one they
  name, never someone else's on its own. The server allows exactly the new parts; the fresh verify worker
  compares old and new (DocInfo / content.hpf only gained the pictures' entries, each part a clean picture, each new
  picture shows a new entry). The render tree is parsed with caps and checked numbers.
- **Chat files:** a form that is a chat file gets a new version through the same path as edit_office.
- **Left out:** pictures in headers or footers, nested tables as targets, explicit page coordinates, HWP to PDF (the
  engine only draws PNG pages; with the picture in the Hangul file itself the PDF detour is not needed).
- **Needs:** the HWP Preview renderer running on the server; without it an image change is refused with that reason and
  text changes work as before.
- **Version impact:** minor (a new capability of edit_hwp).
