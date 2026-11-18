# The AI makes zip files (make_zip) and saves the attachments of an email file (unzip_file)

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (adds to [20261118-unzip-file.md](20261118-unzip-file.md))
- Branch: feat/audit2-files (second limits audit item 8, QA TC-4920)

- **Ask:** the AI said "I can open (extract) ZIP files, but I can't create a ZIP … download that folder and zip it on
  your own computer", and for an .eml attachment "I can only save text files … save quote.pdf from your mail app".
- **make_zip { paths, output? }** (`server/src/tools/make-zip.ts`): files and folders the person may open into one
  .zip. A folder goes in with everything below it that list and read show the person (no links, no hard-linked files,
  nothing hidden; empty folders they may read are kept); its name and tree are kept, a name given twice gets " (2)"
  inside the zip, a path inside another given path is refused. Default output: next to the first path, named after it,
  a free name (" (2)") so it never becomes a conflict copy; an explicit output that exists follows make_file's rule
  (a version when the AI read it in this turn, else a conflict copy). Never under skills/.
- **Limits:** 10,000 files and 2 GB of files per zip, 4 GB per answer (`TurnFiles.zippedBytes`, shared with
  sub-agents), refused up front with nothing saved; a guest keeps the turn's normal write limits. No zip64, so a zip
  stays under 4 GB. Only .zip: no .tar.gz, 7z or passwords (left out: people asked for zip).
- **How:** in the server-wide unzip slot, one file at a time into a work file (`files/zip-stream.ts`: deflated, or
  stored for already-compressed kinds; UTF-8 names with the UTF-8 flag; CRC and sizes written into each local header),
  each file read through the descriptor its permission check saw (`store.ts readRegularPieces`) and checked again just
  before. Saved with placeProduced (access again, file event, index, change published). Before the work, the
  wider-audience card for the folders the files came from (`confirmSources`), so a zip of a narrow folder saved where
  more people read asks first (without a chat: refused).
- **Email attachments in unzip_file:** `path` may be an .eml or .msg. Its attachments are its "files"
  (`server/src/files/mail-parts.ts`): MIME parts that say attachment or carry a file name (RFC 2231 and RFC 2047 names,
  UTF-8 or the Korean code page), base64 or quoted-printable; an attached email is saved as an .eml; pictures inside the
  body (inline with a Content-ID) are counted, not saved. An .msg is read with the bounded compound-file reader
  (`files/cfb.ts`): each attachment storage's data under its long name; an email inside it is named, not saved. By
  default the files go next to the email (no new folder), each under its own name, " (2)" when taken; `to_folder` and
  `list_only` work as for a zip, and so do the zip limits, the slot, the checks and the cards.
- **Why one tool for both:** an email file is a container like a zip, and the person says the same words ("take the
  files out"); one rule in the prompt covers both.
- **After the security review of #1302:**
  - In a shared chat the read card counts every folder with its own rules under each named folder that the asker
    can read (`chat/turn.ts sharedSources`, as for a search), so a restricted sub-folder asks before its names reach
    the chat. (The rooms AI that ROOM_FILE_TOOLS was first written for is gone; the list now only marks a chat's own
    words, and the shared chat's read card is the one gate.)
  - Each folder is checked once per zip, then each file by the rules as they are now, its inode against the walk's
    and its descriptor (10,000 files: about 6 s instead of 80 s).
  - Empty folders count toward the 10,000 entries and are on the wider-audience card; a zip past 4 GB or 65,534
    entries while streaming is a plain refusal; a guest's file count and bytes are checked before any work.
  - A file out of a zip or an email is never saved under a name an AI follows as instructions (CLAUDE.md, AGENTS.md,
    GEMINI.md, SKILL.md): it gets " (2)" as if the name were taken, and the answer says so.
  - An .eml is parsed twice per call on purpose: once for the plan, once in the slot after the cards, so the email is
    not held in memory while a card waits (as for a zip).
- Tests: `tests/unit/c-make-zip.test.ts`, `tests/unit/b-shared-make-zip.test.ts`. Version impact: minor (a new tool).
