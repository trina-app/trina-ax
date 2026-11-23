# A seal goes on the printed mark, and the result says what was checked

- Date: 2026-11-23
- Status: accepted
- Supersedes: none
- Branch: fix/seal-on-mark (the owner: "도장 위치 저것도 루트를 고쳐야한다 그것만 고치지 말고")

- **Why:** in real runs on Word, 2 of 4 seals landed about 10 mm off, because the AI named the whole line and the seal was
  centred on all of it (QA TC-8357). A saved result carried no evidence of where the picture landed.
- **Rule:** Word `over` and edit_hwp's `at` (place over) go through one resolver, `server/src/files/sign-slots.ts`. A text
  that holds a printed sign mark means that mark; "(서명 또는 인)" aims at the seal word. A text with several marks is
  refused and lists them, unless `occurrence` picks one. A text with no mark works as before.
- **Bound to its signer (review of #484):** the mark is matched with its own line by the text around it in its paragraph,
  its section and its table row and column, never by counting: the renderer draws a floating table after the body text
  that follows it, so a count put a seal on another signer. Text after the chosen mark, a sign-like token this tool does
  not know, or a bare mark on a line with another place to sign is refused unless `occurrence` says which.
  **The invariant:** a placement is accepted only if the document's target maps to exactly one drawn location, proved
  from the document's side. Every reading of the page that fits the whole document (each table covered exactly by its
  drawn parts) must put the target in the same place. Nothing is chosen by counting or by dropping what does not fit.
  Equal tables, whole or split, are refused; a split table with no twin is placed. The result names a table only from
  the line the picture was placed on. A generated test (`sign-corpus`) asserts: on the true target or refused.
- **Fill and stamp in one call:** the target is resolved on the document as read, before the call's other changes, and that
  exact paragraph or cell is carried through them (offsets, added rows), so `occurrence` cannot shift to another signer. A
  target whose own text the call changes is refused: fill first, then stamp in a second call. This replaces the rule above
  in the older decision that labels are looked for in the filled text.
- **No slot ids, no read note, no choice by a person's name.** Ids shift with fills and added rows, a note misses chat files
  and guests, and a name could put a seal on someone else's mark with no human check (independent plan review).
- **What is checked, per format:**
  - Hangul with a stored layout: the saved file is laid out again, the same mark is found in it, and the drawn picture is
    compared with that mark, 2 mm per axis. A mark that cannot be found again is "not checked". A measured miss saves nothing. The result says "checked in the preview engine", never that Hangul was checked.
  - Hangul with no stored layout: Hangul wraps by itself. A mark on the paragraph's first line, clear of its end, is placed
    and reported as not checked. A mark on a line that wraps is refused: in Hancom Docs such a seal landed about 17 mm off.
  - Word: servers have no layout engine and none is added. The picture is anchored on the mark's character, using the
    line's real spacing, and the result says "tied to that text, not rendered". LibreOffice measures it in the tests where
    it is installed; real Word was not available.
- **Measured in Hancom Docs:** whole line, one signer of two, "(서명 또는 인)", in .hwp and .hwpx, and the two public
  government forms: the seal is on the mark.
- **Card order:** edit_office asks its card before its worker, so a dry run of the worker comes first when a card will be
  shown: nobody approves a call that is then refused. The card, Always and ownership rules do not change.
- **PDF (`stamp_pdf` `at`):** the same resolver and invariant, on pdftotext's word boxes in the page as shown. One line only,
  the name next to its mark, a known mark as whole words, reading order by line bands, never drawing order. Every word of the
  label and mark must show rendered ink with nothing over it. A solid picture of the seal's size is drawn there first, and the
  page is rendered to see where it really lands and how much shows. On the file about to be saved, every page's words must
  be unchanged and the seal's pixels inside that place. Anything not proved saves nothing, and for the rest of that turn a stamp
  by coordinates on any PDF is refused, so the AI asks the person (a split or rotate makes new bytes, so a block on one file
  could be stepped around). The name and mark must be one printed line with at most one font height between words. ActualText
  that differs from the font's letters, hidden text, turned text (from the glyph matrix), text under 5 pt and a font whose letter
  map reads two letters as one are refused. The page is drawn again with the target's letters taken away, and every letter's
  box must change, so a picture over the text, zero opacity, a white stroke or a white spot colour cannot pass. Every page is compared in a small drawing, so a page two PDF readers read differently cannot change unseen. The
  resolver runs in the office worker, with caps on words (30,000), page pixels, pages (60), memory and time. **Limit:** a
  ToUnicode map that lies consistently cannot be detected without OCR, so the result says the text came from the PDF's text
  layer and the person should check the name beside the seal.
- **Later:** `edit_pdf` `stamp_image` with `at`. The picture-ownership card on PDF waits for the owner: it would stop scheduled
  runs that stamp a shared company seal.
- **Version impact:** patch.
