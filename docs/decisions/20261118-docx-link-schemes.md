# Files made by make_file link only to the web, mail and the document itself

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: fix/docx-link-schemes (QA TC-4949); built on fix/any-file-template (#1281)

Plan: docs/AGENTS/plan/20261118-1700-docx-link-schemes.md.

- **Problem:** pandoc writes a Markdown link into a Word or PowerPoint file as it is. A link to `file:///C:/...calc.exe`,
  to a network share `\\host\share\x.exe` (which also sends the reader's Windows sign-in to that host), `javascript:`,
  protocol handlers (`ms-word:`, `search-ms:`, `ms-msdt:`) and relative paths (`../../x.exe`, opened next to wherever the
  file is saved) all became links someone could click. The Markdown can come from the AI or from a team-folder .md
  someone else wrote. A template (any file the person can read, #1281) adds its own parts to the file: links and fields
  in its header, linked pictures, and an attached template Word fetches when the file opens. A PDF printed from an .html
  page or drawn from a deck keeps the page's `<a href>` links, whatever their scheme.
- **Rule:** link targets may be `http://` / `https://` addresses, `mailto:` (only the `to`, `cc`, `bcc`, `subject` and
  `body` parameters — never `attach=`, which some mail apps act on) and `#name` (a heading in the document). No white
  space, control or format characters, or backslashes in them. One list of what is allowed (`files/office-rules.ts`,
  shared with #1281's template check) so the pieces cannot drift apart.
  - In pandoc's tree (docx, pptx, pdf), any other link becomes its plain text (same words, same colour attributes). The
    result tells the AI which targets were dropped, so it can tell the person. Stripping, not refusing: the document is
    still useful and the row asks for the link to be "dropped or kept as plain text".
  - The finished .docx / .pptx / .xlsx is checked in the office worker (`files/office-links-check.ts`) with a real XML
    parser (saxes, namespaces resolved), not pattern-matched, so no quoting, prefix or `>` inside an attribute value can
    hide a link. Every `.rels` part (headers, footers, footnotes, numbering, theme, masters, charts): an external
    relationship must be a hyperlink to an allowed target, and an internal one may not name a scheme, a share or a
    backslash path; a linked object, frame or subdocument is refused. Every Word part: a field must be on the allow-list
    in `office-rules.ts` (page numbers, dates, references, a HYPERLINK to an allowed target), so DDE, DDEAUTO,
    INCLUDETEXT, INCLUDEPICTURE, IMPORT, LINK, DATABASE, RD, MACROBUTTON, ADDIN, PRIVATE, an unknown field, or a field
    whose name is built by a nested field, is refused. Nothing is saved then.
  - A PDF from an .html page or a deck has its link annotations filtered before it is saved (`files/pdf-links.ts`,
    pdf-lib): a URI action to a web page or a mail address stays, and any other URI, or an action that launches a file,
    opens another document, runs JavaScript or submits a form, is made inert. The Markdown PDF path (typst) needs no
    filter, its links are cleaned in the tree.
  - A Word template's attached template (`settings.xml` `w:attachedTemplate`, usually a local `Normal.dotm` path) is
    taken out, not refused, at the template check (#1281's `files/office-template.ts`, changed here): real templates
    carry one, and the new file does not need it.
- **Not changed:** hwpx and the safe-ops PowerPoint path refuse links already. edit_office (edit_hwp and the Word
  comment tool) is not given this check: it changes a file the person already has, which may well link to `\\fileserver`
  on purpose. Embedded OLE objects and altChunk parts a template carries are refused by #1281, not inspected here.
- **Tests:** tests/unit/sec-make-file-links.test.ts (and the attached-template change in tests/unit/sec-office-template.test.ts).
- **Version impact:** patch.
