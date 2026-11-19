# make_file: HYPERLINK in Excel formulas, except links to a computer or network share

- Date: 2026-11-18
- Status: accepted
- Supersedes: "HYPERLINK refused" in DECISIONS.md (xlsx formulas) and in `20261118-rich-office-output.md`
- Branch: feat/pdf-text-edit-xlsx-hyperlink (owner rule 2026-11-19 "Claude Code is the floor", QA TC-4993)

- **Ask:** make_file refused every formula with HYPERLINK. Claude Code writes any formula with openpyxl.
- **Rule:** HYPERLINK is allowed when its link (the first argument) is written in the formula as "text":
  - a web page, `http://` or `https://` with a host; it may go on with `&` and cells (`"https://example.com/item/"&A2`),
    since the text it starts with fixes the kind of link; a comparison (`=`, `<`, `>`) outside parentheses in that argument is
    refused, since it would turn the link into TRUE or FALSE;
  - a mail address, `mailto:` (parameters subject, body, cc, bcc, to only), written out whole: `&` after it is refused,
    since it could add another parameter such as `&attach=` (review of #1337);
  - a place in this workbook, written out whole: `"#Sheet1!A1"`, `"#'Q3 sales'!B2:C9"`, `"#Total"` (never `[file]`).
  Refused, with one line why ("a file:, network-share (\\server) or other local link is refused, because opening one can
  hand a coworker's Windows sign-in to another computer"): `file:`, `\\host\share`, `//host`, relative paths,
  `javascript:`, program schemes (`ms-word:`, `search-ms:`), a link taken from a cell or built by another function, a
  place built from cells, spaces or backslashes in a web link, and a prefixed name (`_xludf.HYPERLINK`).
- **Why the one limit stays:** a shared workbook is opened by coworkers; a link to their own computer or network can run
  a program or send their Windows sign-in to another host. That protects one person from another's file, the only kind
  of limit the owner rule keeps. The allow-list is the one of the Word and PowerPoint links (#1315, office-links.ts:
  http, https, mailto, places in the document); it is kept small here and can use that module once both are on dev.
- **Kept:** every other blocked function (WEBSERVICE, INDIRECT, DDE, IMPORT…), external workbook references, DDE links.
- **Tests:** tests/unit/c-tools.test.ts (allowed and refused targets; make_file writes the formula; a file link saves
  nothing); c-make-file-rich and the old HYPERLINK cases now use a file: link.
- **Version impact:** minor.
