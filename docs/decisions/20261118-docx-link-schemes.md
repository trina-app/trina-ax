# Files made by make_file link only to the web, mail and the document itself

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: fix/docx-link-schemes (QA TC-4949)

Plan: docs/AGENTS/plan/20261118-1700-docx-link-schemes.md.

- **Problem:** pandoc writes a Markdown link into a Word or PowerPoint file as it is. A link to `file:///C:/...calc.exe`,
  to a network share `\\host\share\x.exe` (which also sends the reader's Windows sign-in to that host), `javascript:`, protocol
  handlers (`ms-word:`, `search-ms:`, `ms-msdt:`) and relative paths (`../../x.exe`, opened next to wherever the file is
  saved) all became links someone could click. The Markdown can come from the AI or from a team-folder .md someone else
  wrote. A team template from skills/ adds its own parts to the file: links and fields in its header, linked pictures,
  and an attached template that Word fetches from a path or share when the file opens.
- **Rule:** link targets may be `http://` / `https://` addresses, `mailto:` and `#name` (a heading in the document).
  No white space, control or format characters, or backslashes in them.
  - In pandoc's tree (docx, pptx, pdf), any other link becomes its plain text (same words, same colour attributes). The
    result tells the AI which targets were dropped, so it can tell the person. Stripping, not refusing: the document
    is still useful and the row asks for the link to be "dropped or kept as plain text".
  - In the finished .docx / .pptx / .xlsx, whoever wrote it: every relationship with TargetMode External must be a
    hyperlink to an allowed target, and an internal one may not name a scheme, a share or a backslash path. In Word
    parts, a HYPERLINK field to anything else (or whose target is made by a nested field) and any DDE, DDEAUTO,
    INCLUDETEXT, INCLUDEPICTURE, IMPORT or LINK field is refused. Nothing is saved, and the message names the template
    when one was given: these come from the template, not from the AI's text, so there is nothing to strip.
  - A Word template's attached template (word/settings.xml `w:attachedTemplate` and its relationship) is taken out
    instead: real Word templates carry one, usually a path to Normal.dotm on the machine that made them, and refusing
    would break the team's templates. Word shows the file the same without it.
- **Not changed:** hwpx (its writer refuses links), the safe-ops PowerPoint path (refuses Link nodes), comment_docx
  (plain-text comments in the person's own file), xlsx formulas (HYPERLINK was refused already; the package check is a
  second guard). Embedded objects inside a template (OLE packages, altChunk parts) are not looked at here.
- **Tests:** tests/unit/sec-make-file-links.test.ts.
- **Version impact:** patch.
