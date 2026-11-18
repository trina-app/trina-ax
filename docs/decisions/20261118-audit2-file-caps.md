# File caps from the first scaffold, raised to what memory and disk hold

- Date: 2026-11-18
- Status: accepted
- Supersedes: the size line of [20261116-mail-attach-team-file.md](20261116-mail-attach-team-file.md) (10 files, 10 MB)
- Branch: fix/audit2-file-caps (second limits audit N26, N27, N29, N30 charts, N31, N38, N39; QA TC-4972..TC-4978)

Plan: docs/AGENTS/plan/20261118-1705-audit2-file-caps.md.

- **Ask:** the owner wants the AI to work like Claude Code. A limit Claude Code does not have is a bug unless it protects
  one person's data from another. The second limits audit found seven caps that were set when each tool was first
  written and never measured again.
- **Rule:** a cap stays only where memory or disk needs it, at a measured value, and the AI is told what was cut and how
  to go on. The memory guards (office worker 2 GB RSS plus the converter cgroup, the image helper's 1536 MiB) and the
  disk floor (`assertStorageRoomForAI`) stay as they are.
- **PDF tools (edit_pdf, merge_pdfs, split_pdf, stamp_pdf): 40 MB -> 100 MB per call.** Measured on this Mac
  (Bun 1.3.12, `--smol`, the real worker mode): pdf-lib holds the input, its parsed objects and the new file at once,
  about 9-10 times the input. A 100 MB scan-like PDF peaks at 1.05 GB, 150 MB at 1.5 GB, 200 MB at 2.0 GB (the worker
  cap). 100 MB keeps half of the cap for a PDF of many small objects, which costs more per byte than a scan. The 200 MB
  of the audit would hit the cap. The new file comes back through `officeWorkerWrite` with its own answer cap,
  `PDF_OUTPUT_MAX` = 160 MB (the other office tools keep 64 MB). The worker's time grows with the input
  (`officeWorkerTimeoutMs`, as reads). A file over the limit is still refused before anything is read, in the same words.
- **resize_images: 32 MB -> 150 MB per photo, 200 MB -> 1 GB per call, 60 s -> 120 s per photo.** The Go helper had the
  same 32 MB (`safeops.ResizeInputMax`), so it is raised there too (one constant). The pixels (50 MP), not the bytes,
  bound the decoded image. Measured: a 147 MB 49 MP PNG peaks at 750 MiB, a 102 MB 49 MP 16-bit PNG at 840 MiB, under
  the 1536 MiB limit; the slowest case (to under 2 MB) took 15 s. Photos are made one at a time, so the per-call total
  only bounds the call's time.
- **save_room_file: 50 MB -> the room's own limit (1 GB).** The copy is streamed (`files/store.ts copyRegular`: 4 MiB
  pieces, never whole in memory, hashed on the way). The disk is checked before the copy. The safety check judges the
  hash of the very bytes copied (`Quarantine.assertHash`; the held-file check before the card is unchanged). Every
  permission and audience check is the same. Left out: the person's own "Save to team folder" sheet
  (`rooms/save-to-team.ts`) still stops at 50 MB; it has its own web text and is a follow-up.
- **read with versions: 8,000 -> 40,000 characters of changes per read, and `offset` to read on.** The whole diff is
  made (both sides stay capped at 2 MB of text), then cut at whole lines. The result says "cut at line N of M: for the
  rest, the same read with offset: N+1"; a read with offset says which lines it shows. The `versions` description says
  long changes come in parts.
- **Team files on a mail: 10 MiB / 10 files -> 18 MB / 20 files.** Megabytes as mail services count them (1,000,000
  bytes), also in what the AI and the card say. Base64 makes 18 MB 24 MB, its line breaks (76 characters + CRLF)
  24.6 MB, and the mail's own text and headers fit under Gmail's and Outlook.com's 25 MB. 18 MiB would be 25.8 MB, so
  the decimal megabyte is the limit. The count only bounds the card; the bytes are the real limit. A service that takes
  less on its own path refuses in its own answer, which the AI gets.
- **Artifacts: 2 MB -> 10 MB.** A version is a row of `artifacts`; SQLite takes it, and the web panel loads the page
  in its sandbox frame as before. "Save to the team folder" takes up to 10 MiB of text (`SaveContentBody`), so a saved
  artifact still fits. Every version is kept whole, so the disk floor now applies before a version is stored. Over the
  limit, the AI is told to split it over several artifacts or save it as a file.
- **make_file charts: 10 -> 50 per workbook** (`MAKE_FILE_CHARTS_MAX`, the schema and the writer share it). The
  HYPERLINK/INDIRECT formula rule is unchanged (owner decision).
- **Also found:** a PDF result over 50 MB is still refused by the per-answer write cap (`maxWriteBytesPerTurn`,
  50 MB) until PR #1284 raises it to 1 GB; that cap is its own audit item (first audit #5).
- **Tests:** tests/unit/c-audit2-file-caps.test.ts (a 70 MB PDF edited, a 40 MB photo reaches the helper, versions in
  parts, a 5 MB artifact, 50 charts), tests/unit/b-chat-rooms-save.test.ts (a 60 MB room file saved whole),
  tests/unit/c-integrations-attach.test.ts (18 MB, 20 files), native resize_test.go `TestResizeInputLimit`.
- **Version impact:** patch.
