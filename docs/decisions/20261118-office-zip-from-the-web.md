# save_url saves Office, CSV and ZIP files; web_fetch reads their text

- Date: 2026-11-18
- Status: accepted
- Supersedes: the type list of "save_url" (docs/DECISIONS.md: pictures, PDF, video and sound only) and web_fetch's
  "web pages, text, JSON and PDF"
- Branch: feat/audit2-files (second limits audit item 10, QA TC-4922)

- **Ask:** a spreadsheet, Word file, CSV or ZIP on the web could not be fetched or saved. Claude Code does `curl -o`.
- **Rule (save_url):** it also takes Word, Excel, PowerPoint (with macros too: .docm/.xlsm/.pptm), Hangul (HWP, HWPX),
  OpenDocument, Outlook .msg, CSV / TSV and ZIP, still judged by the bytes, never by what the site says
  (`server/src/tools/sniff.ts`). A zip or a compound file is settled on the whole file after the download
  (`settleKind`): the names in a zip's directory (`file-list/sniff.ts`: `word/`, `xl/`, `ppt/`, a VBA project, HWPX,
  OpenDocument), the streams of a compound file (`WordDocument`, `Workbook`, `PowerPoint Document`, Hangul's
  `FileHeader`, an Outlook message; `files/cfb.ts`). A table is text whose name or type says CSV / TSV (Excel sends
  `application/vnd.ms-excel`). The extension is corrected to the real type, as for pictures.
- **Still refused:** HTML, SVG, scripts and programs as before; app packages (APK, JAR, browser extensions, Windows
  app packages, by their names or the files inside); installers and other compound files (MSI); a zip whose directory
  cannot be read; a "CSV" that is really a page. A zip is stored as it is, never opened by save_url (unzip_file does
  that on request).
- **Rule (web_fetch):** a body that is none of page, text, JSON or PDF goes through the same sniffer; Office files and
  tables are read through the normal extractors with the text layer only (`files/extract.ts`, the isolated converters,
  the quarantine check), passed in by the tool (`extract`); a zip gives the list of its files and sizes, never their
  contents; an old .doc / .ppt / .msg is not read ("save it with save_url"). A file cut at the 5 MB limit is not read
  (a cut Office file or zip is no file): the AI is told to save it with save_url and read the saved file.
- **Unchanged:** the address rules, the private-network and SSRF checks, every redirect hop checked, the egress and
  link budget, the 1 GB card, the disk reserve, the wider-audience card, the 5 MB / 15 s limits of web_fetch.
- Tests: `tests/unit/c-office-from-web.test.ts`, `tests/unit/save-url.test.ts` (a damaged zip). Version impact: minor.
