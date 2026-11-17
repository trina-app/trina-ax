# A PDF the AI made in this turn is stamped or edited in place

- Date: 2026-11-17
- Status: accepted
- Supersedes: the "always a new file next to the original" default of [20261116-edit-pdf.md](20261116-edit-pdf.md), for this one case
- Branch: fix/stamp-own-fresh-pdf (QA row for real-AI flow FL-08)

- **Ask:** in real-AI runs of flow FL-08 ("make the Saaja Bakery quote PDF, stamp the company seal on the last page"),
  2 of 4 runs left quote PDFs in the person's own folder instead of the team's quotes folder.
- **What the runs showed (4 runs, 2026-11-17, commit 90fd57cda):** the AI never relied on a default place. In every run
  it wrote an HTML draft, made a PDF with make_file, then called stamp_pdf with an explicit `output` in
  `groups/영업/견적서/`, the folder the quote skill names. The stamped PDF always ended up there. What varied was the
  *unstamped* PDF: stamp_pdf saves a new file and leaves its input as it is, so the AI had to park an unstamped
  copy somewhere first. It put it in `users/<id>/견적서-원본/` or `견적서-작업/` (2 runs) or next to the stamped one in
  the team folder as "(직인 전)" (1 run). In one run the canonical name in the team folder was the *unstamped* file and
  the stamped one was "(직인).pdf". The cause was the tool's shape, not an unclear skill.
- **Rule:** stamp_pdf and edit_pdf without `output` change the input file in place when the AI made that PDF itself in
  this turn and its bytes are still the ones it wrote (`madeThisTurn`: the turn-wide hash `madeHashes` that make_file and
  the PDF tools record when they save, plus this agent's own read hash; a re-read after someone saved over it does not
  count, and a file saved from the web or a room with save_url / save_room_file is not "made").
  The result is a new version; the version without the seal stays in the file history. Any other PDF (only read,
  made in an earlier turn, saved over by someone since) keeps the old default: a new file "<name> (stamped).pdf" /
  "(edited).pdf" next to it. A named `output` always wins. The tool descriptions, the `output` field and the PDF tools
  rule say so ("make the PDF where it belongs and stamp it there"), and a fresh stamp's result says to fix a wrong spot
  by making the PDF again, not by stamping the stamped file a second time.
- **Why:** the person asked for one quote in the team's quotes folder. The AI's own draft of this turn is not the
  person's file, so changing it needs no "replace the original" ask, and nothing is lost (file history).
- **Left out:** make_file has no "no place" case (`output` is required), so it gets no new default. The HTML draft the
  AI writes for make_file may still sit in the person's own folder. That is a private working file, not the quote. The
  FL-08 fixture's skill names `shared/도장/직인.png` while the file is `회사직인.png`, so every run first gets "not found".
  That is a scenario-data fix for the runner branch.
- **Tests:** `tests/unit/c-stamp-pdf.test.ts` "a PDF the AI made in this turn", `tests/unit/c-edit-pdf.test.ts` "edit_pdf
  on a PDF the AI made in this turn".
- **Version impact:** server only; no migration, no screen text.
