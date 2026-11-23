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
- **Later:** PDF gets the same target and the same picture card; the Word preview's vertical offset is QA TC-8358.
- **Version impact:** patch.
