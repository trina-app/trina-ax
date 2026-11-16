# A file link the AI mis-typed is pointed at the file its label names

- Date: 2026-11-16
- Status: accepted
- Supersedes: the "Left out" line of [20261116-ai-file-link-labels.md](20261116-ai-file-link-labels.md) for this one case
  (links are still not made from backticked paths)
- Branch: fix/flow-regressions-0512 (AI flow run on dev 30a54f4e2, FL-01 and FL-28)

- **Ask:** answers linked the right label to a broken path: [단가표-2026.xlsx](…%EB%8B%A8%EA%B8%B0%ED%91%9C…) ("단기표") and
  [2026-11-15-일요일-회의록.md](…일요일-을요일-회의록.md). The link opened nothing.
- **Why:** the instructions ask for /files/view?path=<team path, URL-encoded>, and the model writes the percent-encoding
  of Korean paths byte by byte itself. One wrong byte is another syllable (가 %EA%B0%80 → 기 %EA%B8%B0), or it repeats a
  word. Nothing in #1062's code builds these links; the server's own "Link for the user" lines (make_file and others)
  were right.
- **Rule:** in the answer stream of every engine (chat/file-link-repair.ts, before the key redactor), a Markdown link to
  /files/view or /api/files/download whose `path` is no file or folder the person may read is pointed at the entry of
  the link's folder named by its label (or by its own last part), else at this turn's own file of that name when there
  is exactly one. Names match by NFC, so a file stored decomposed (NFD, from a Mac) matches. Only the `path` value
  changes (&sheet=, &page=, # stay), only to a path the person may read; anything else stays as written. A link that
  is not complete yet is held back until it is, so the person never sees the broken one.
- **Left out:** asking the model to write unencoded paths (every link reader on the server and in the apps parses
  encoded ones), and guessing between two files of the same name.
- **Tests:** tests/unit/b-file-link-repair.test.ts.
- **Version impact:** patch.
