# A page taken out of a PDF takes its content out of the file

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/pdf-prune-removed-pages (QA TC-3793, found on merged dev 2026-11-16)

- **Ask:** edit_pdf removed a page and its 480 KB picture stayed in the saved PDF (481 KB where 1 KB was right). A
  person removes a page because its content must not go out, so content that stays in the file is a privacy fault.
- **Cause:** three ways a removed page's content reached the result (`server/src/files/pdf-pages.ts`):
  1. `pruneResources` skipped a kept page whose `/Contents` was no stream (null, a reference to a missing object), so
     that page kept the whole shared `/Resources`, with every other page's pictures.
  2. It cut only `/XObject` and `/Font` of the page, not the other lists (`/Pattern`, `/ExtGState`, `/Shading`,
     `/ColorSpace`, `/Properties`) and not the `/Resources` of forms, patterns, soft masks, Type 3 fonts and annotation appearances,
     which some generators point at the same shared list.
  3. pdf-lib copies everything a page points at. A link to a removed page (`/Dest`, `/A`), a form field with another
     part on a removed page, or an article bead brought that whole page object along: text, pictures, notes,
     thumbnail. It was in no page list, but in the file.
- **Rule:** whenever pages are left out (edit_pdf `remove_pages`, `keep_pages`, `insert_pdf` with `pages`; split_pdf;
  merge_pdfs with `pages`) the result is a new document built from the kept pages only:
  - before the copy, each kept page gets its own `/Resources` with only the names its content uses, in every list;
    the same for every stream with its own `/Resources` that the page still reaches. A `/Contents` that is no stream
    draws nothing and keeps nothing. A form without `/Resources` draws with the page's, so its names count for the page;
  - after the copy (`dropUnreachable`), a page object that is not one of the result's pages is cut loose with its
    annotations and form-field parts; a link on a kept page that led to it is removed; `/B` (article threads) is
    removed; a form field left without parts is removed; then every object the result's trailer does not reach is
    deleted, so only reachable objects are written;
  - the save is pdf-lib's full rewrite (one xref, one `%%EOF`), never an appended update, and the source's catalog is
    not copied: outline, named destinations, attachments, AcroForm, document metadata and structure tree do not come
    along.
- **Kept pages stay the same pages.** `copiesOf` tells pdf-lib's copier where each kept page goes, and `keep_pages` /
  `reorder_pages` move the page objects instead of copying them. Before, a link between two kept pages made a second,
  unseen copy of the target page (the link led to the copy, and the page's content was in the file twice).
- **A page that cannot be decoded:** when pages are left out and a kept page's content stream (or a form it draws)
  cannot be decoded, the job is refused ("…so pages cannot be taken out of it safely; nothing was saved", code
  `pdf_invalid`): nobody can say what that page uses, and keeping everything is the fault above. With no page left out
  (reorder, rotate, a whole-file merge) such a page keeps its resources and the job works as before.
- **What can still stay** (each checked by the independent review, see below):
  - what a kept page itself carries: its own content, annotations and form-field values. A form field with parts on
    a kept page and on a removed page keeps its one value (a radio group's choice);
  - text or pictures a kept page draws outside its visible box;
  - a resource the kept page's content names without showing it, and a name that appears inside a string or an
    inline picture of the content (kept, never dropped by mistake). In `/ColorSpace` and `/Properties` a name counts
    when the content writes it anywhere; the other lists are read by their operator (`Do`, `Tf`, `gs`, `sh`, `scn`);
  - the names of optional-content layers that a kept page's own layer membership (`/OC` with `/OCGs`) lists;
  - an edit that leaves no page out (rotate, stamp, text, stamp_pdf) rewrites the file in full but does not look for
    objects the source file itself no longer used.
- **What a kept page can lose:** a form that has its own `/Resources` but draws with a name only the page's list
  has (not allowed by the PDF rules; some viewers allow it) loses that picture or text. Merging the same file twice
  with page lists drops links between those pages.
- **Independent review (2026-11-16):** about 95 hostile PDFs, each through 12 ways of leaving pages out, checked with
  pikepdf (qpdf), poppler and a byte scan with every stream inflated. It found, and this change then fixed:
  - a form-field part or note of a removed page that has no `/P` came along through `/Kids`, `/IRT` or an action. Now
    every annotation that is on none of the kept pages is cut loose, whatever it says about its page;
  - trees over the whole document reached from a kept page: `/DPart` and a thread action are removed, as is a
    structure destination (`/SD`);
  - a Type 3 font's `/Resources` are cut by what its glyphs draw; a font or form without `/Resources` counts for the
    page; a kept page's other keys (`/PieceInfo`, …) are walked too;
  - `/DefaultGray`, `/DefaultRGB`, `/DefaultCMYK` are always kept; a comment or NUL between a name and its operator
    is read; a name written with `#xx` in the list is compared and written as the name it is (pdf-lib wrote its `#`
    as `#23`, which lost the picture);
  - a content stream with `/DecodeParms` (a predictor, which pdf-lib does not apply) counts as unreadable: refused;
  - a kid of the page tree without `/Type /Page` (viewers show it, pdf-lib does not count it, so "remove page 2"
    took out another page): edit_pdf, merge_pdfs and split_pdf refuse such a file;
  - a destination dictionary that points at itself no longer loops.
  Not changed: pdf-lib's own errors on a page whose `/Contents` is a number or a dictionary when text is added, and on
  a `/Resources` that is an array (nothing is saved).
- **Left out:** carrying the outline or named destinations over for the kept pages (they were never carried over
  after a removal); telling the AI in the tool result that links were removed.
- **Tests:** `tests/unit/pdf-pages-removed-content.test.ts` (a fixture with a picture, forms, a font file, a pattern, a
  soft mask, a thumbnail, notes, form fields, a thread, outline, attachment: nothing of the removed page in the saved
  bytes or any decoded stream, size under 4 KB from 60 KB, no unreached object, links between kept pages kept; and
  each finding of the review),
  `tests/unit/c-edit-pdf.test.ts` (the tool path, TC-3793's two odd `/Contents`).
- **Version impact:** patch. No schema or API change.
