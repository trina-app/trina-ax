# Hangul documents are laid out like the Word ones: layout in Markdown, Korean outline labels, a Hangul writing guide

- Date: 2026-11-24
- Status: accepted
- Supersedes: none (extends docs/decisions/20261124-doc-skills.md "Hangul stays on make_file")
- Branch: fix/hwpx-quality (QA TC-8596 and the 11-24 공문 run on qa.trina.app, build dbf0fe0e8; owner: designed
  HTML→PDF quality, no per-case tuning)

- **Ask.** A 공문 made in Hangul could not be sent: a "구분/내용" table as its header with an empty (경유) row, items
  left as "[… 기재]", the organisation and sender as left-aligned headings. Word, Excel and PDF from the same build
  could, because the AI reads Anthropic's document skills for them and lays the page out itself.
- **Root causes.** (1) make_file's Markdown → .hwpx writer could not centre or size a line, frame a box, draw a line,
  merge cells or drop a table's lines, so the AI could not lay out a letterhead or a 발신명의 even when it knew how
  (it said so in its answer). (2) Korean outline labels (1. 가. 1) …) were plain text with no indent, and lines that
  start with one ran into the paragraph above. (3) The AI had one line of instructions for Hangul and nothing on how
  Korean documents are laid out or what to do with facts it lacks. (4) Nothing told it to look at the pages.
- **Rule.**
  - The writer takes pandoc's own attribute syntax, so the AI writes nothing new: fenced divs `.center` `.right`
    `.left` `.justify`, `size=<6-48 pt>`, `.box` (one framed cell around paragraphs) and `.noborder` (a table without
    lines); a pipe table whose header cells are all empty has no header row; grid tables merge cells; `---` is a line;
    underline and strikethrough; lists and divs in cells. Column widths come from the Markdown or, when it gives none,
    from what each column holds. Text larger than the body gets room above and below. Unknown div attributes are
    refused with the list of known ones, like every other refusal.
  - A paragraph that starts with a Korean outline label is laid out by its level: 1. → 가. → 1) → 가) → (1) → (가) →
    ① → ㉮ (행정 효율과 협업 촉진에 관한 규정 시행규칙 제2조), and □ → ○ → - → · of 개조식 reports. Each level is one
    character further in; wrapped lines go under the text (Hangul's 내어쓰기, a negative indent). A source line that
    starts with a label starts a new paragraph, and a bullet list right under an outlined line continues it as dash
    lines (files/hwpx-check.ts `normalizeHwpxTree`, used by the writer and by the read-back alike, so a file still has
    to read back as the document). pandoc reads a Hangul document without `fancy_lists`, so "1)" and "(1)" stay labels,
    and a line that starts with a Korean date ("2026. 11. 24.") is text, not a list that starts at 2026.
  - The AI's instructions, only while Hangul writing is on (server/src/chat/prompt.ts `HWPX_GUIDE`): what the writer
    can lay out; the general layout of 공문/기안문, 보고서/계획서, 회의록 and 안내문; dates and amounts; facts (use what
    the request, chat, company profile and files give, write the rest of the content as a complete draft, never an item
    as a placeholder; ○○ only for a detail only the person knows, named in the answer; ask only when a missing fact
    decides the document). Then look at every page with hwp_render and make it again under the same name, or say the
    pages were not seen where the preview is not offered.
- **Not a vendored skill.** There is no Hangul document skill upstream (github.com/anthropics/skills has docx, pptx,
  xlsx, pdf). The guide is ours and short enough to sit in the instructions, so it reaches every install where
  Hangul writing is on (also without a run), unlike a skill read with box_shell.
- **Considered and not done.** Building a .docx (or HTML) with the document skills and converting it to .hwpx: it would
  help only where a run exists, and a second layout model (OOXML → OWPML) would have to be kept right for every
  feature the AI might use. Pictures in a new .hwpx (a seal goes in with edit_hwp afterwards), page numbers, headers and
  footers: later, if measured output needs them.
- **Measured.** Ten held-out Korean requests (공문 ×2, 기안문, 보고서, 회의록, 안내문, 계획서, 결과보고서, 사내 공지,
  업무협조전), written before the change, through the real AI on a local server (this Mac's Claude Code login, the HWP
  plugin on), before and after, judged blind in pairs by two Sonnet judges: see the PR.
- **Security.** The writer still runs only in the office worker; new inputs are bounded (div depth 16, sizes clamped,
  merged cells checked against the table's grid, the same text and cell limits).
- **Version impact.** minor: Hangul documents can hold more layout and the AI writes them differently.
