# Find work files: a big Documents is walked level by level; Windows always walks the three folders; "Choose a folder…"

- Date: 2026-11-17
- Status: accepted
- Supersedes: none (adds to "Find work files, part 4" and part 5 in DECISIONS.md, and 20261117-find-work-small-files.md)
- Branch: fix/find-work-files-big-documents (QA row MAN-057, second look)

- **Problem:** on a Windows 11 PC (desktop 0.5.12), after consent the list had 2 files, said "Documents is big, so
  only part of it was looked at", missed the three quotes in Documents › QA desktop test › Quotes, and offered no way to
  pick a folder. Causes found in the look:
  1. The walk went newest folder first, with only two weeks' handicap per level. A fresh big folder (an export, an
     unzipped tree, a game's saves) was read whole and used up the walk's 20,000 entries or its time before older
     folders beside it, so a folder two levels down was never reached.
  2. One folder could give any number of entries and documents (up to the root's 5,000), so a folder of thousands of
     notes filled the list.
  3. On Windows, Windows Search's answer replaced the walk whenever it knew even one file in a folder. Its query takes
     the 2,000 newest rows of the whole home folder, so a few rows of a big Documents (or none of files it has not indexed
     yet) were all that was listed. The first folder also waited for that query (up to 10 s of PowerShell) inside the
     look's 20 s, and work folders were walked before the three folders.
  4. Four folders down at most: an office's "Clients › Acme › 2026 › Quotes" is five.
  5. "Choose it yourself" existed only for a folder macOS kept the app out of.
  (The tiny-file drop of 20261117-find-work-small-files.md is fixed on dev, but was not yet in 0.5.12.)
- **Decision:**
  - The walk is breadth first: a level is done before the next, newest folders first within a level.
  - One folder gives at most 20,000 entries and 400 documents (office types first: xlsx, docx, pptx, pdf, hwp, csv…);
    more is "cut", the folders beside it are still walked. Six folders down. Entries are cheap (a name each); time is
    the bound (10 s a folder in the walk, as before).
  - Never entered (with node_modules, .git, AppData, Library): venv, cache, caches, My Games, WindowsPowerShell,
    IISExpress, SteamLibrary.
  - Windows: Documents, Desktop, Downloads (and a messenger's folder) are always walked; Windows Search's rows join after
    the walk (who wrote it, the company, recent files the walk did not reach), waited for at most 6 s, never before the
    walk. Order: messengers' folders, the three folders, work folders, cloud drives. The wide look's 20 s start after the
    drive list is known. A folder OneDrive keeps is still never walked.
  - "Choose a folder…": one quiet link in the list's header (and on the empty screen), only after a look and only in an
    app that has it (bridge `workFiles.pickFolder`, optional). The system's folder window opens at Documents; the pick is
    the person's permission. Never the home folder or one holding it, never the apps' data (AppData, Library, dot
    folders, node_modules; a Mac's cloud drives under Library are fine). The folder is walked (never the index alone),
    its files join the latest look (same read limits and hour) and show at once ("3 files in Quotes · Show all").
    Nothing is ticked and nothing is read until Add, as before.
- **Time is shared (independent review):** the look has one end (20 s, the narrow look too); each walked folder gets
  its share of what is left (its wait for Windows Search's rows included, at most a third of it), and the wide look keeps
  3 s back for the recent files elsewhere. A cloud drive's folder on Windows (never walked) still gets its index rows
  after the end, for 2 s.
- **"Choose a folder…" limits (independent review):** only right after the person's own press on the page, 3 s apart;
  never the system's folders (Windows, Program Files, ProgramData, another person's Users folder; a Mac's /System,
  /private, /usr, /Applications, /Library) or another person's home; a Mac never enters an online-only folder of the pick;
  a Windows cloud folder is answered by the index only; a share or another volume is read one call at a time and the
  first call that does not answer ends it. The name shown is never a path (a drive's top: its letter; a folder named like
  a root folder: "Documents (Archive)").
- **Not changed:** nothing is looked at before the consent window's yes; nothing pre-picked; files go to My files
  first; only names, sizes and dates are listed; the AI sees names only; contents are read only after Add.
- **Needs a desktop release:** the look runs in the desktop app's main process; the page's link appears only with an app
  that has `pickFolder`.
