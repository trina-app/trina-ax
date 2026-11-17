# Find work files: the app lists small files; the page keeps them out of the picks

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: fix/qa-man-057 (QA row MAN-057, 2026-11-17)

- **Problem:** on a Windows 11 PC, three quote files of 38 to 53 bytes in Documents › QA desktop test › Quotes were
  not found. The app's look reached them and then dropped them (`tooSmall`: text under 2 KB, other documents under
  1 KB). Search by name runs only over the files the app lists, so "quote" said "No file matches".
- **Decision:** the app lists every file of a document type that is not empty (walk and index). The size rule
  (`tooSmall`) applies on the page only (`web/src/lib/workFiles.ts` `notWork`): small files are not suggested as work,
  not sent to the AI and not shown in "May be personal" (`personalList`). Search by name finds them.
- **Why:** the owner's rule of 2026-11-15 ("it only brought really useless ones") is about the picks. It stays. A file
  the look saw must be findable by its name.
- **Not changed:** the limits of the look (documents and entries counted before the size rule, as before).
