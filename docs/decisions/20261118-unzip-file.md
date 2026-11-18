# The AI unzips a zip file: unzip_file

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: feat/ai-unzip (QA TC-4847)

Plan: docs/AGENTS/plan/20261118-0700-unzip-file.md.

- **Ask:** in a project chat a person had the AI put an attached zip in the project folder, then said "zip 풀어서 놔둬".
  The AI said it could not unzip or look inside and asked them to unzip it on their computer and upload the files again.
- **Shape:** one new tool, `unzip_file { path, to_folder?, list_only? }`, the archive twin of the PDF and photo tools:
  an existing file in, new files out, make_file's save path (placeProduced) for every file, so permissions, versions,
  file events (and through them the file list and the text index) and published changes are the same as for any file
  the AI makes. Only .zip; other archives (7z, rar, alz, egg, tar) are named and refused.
- **Where:** by default a new folder next to the zip, named after it; when everything in the zip sits in one folder,
  that folder's name is used and the extra level is dropped. A taken folder name gets " (2)". `to_folder` puts the
  contents into another folder (made when missing), keeping the zip's folders; a taken file name there gets " (2)".
  Nothing is ever saved over an existing file.
- **Names:** UTF-8 when the zip says so (flag bit 11) or carries an Info-ZIP Unicode path whose CRC matches; else UTF-8
  when the bytes are valid UTF-8; else CP949 (Korean Windows without the flag). NFC, "\" read as "/".
- **Refused, nothing saved:** an absolute path or ".." in any entry (a zip made to write outside its folder), zip64,
  encryption, a damaged directory, more than 5,000 entries, more than 200 MB unzipped (the zip-guard limit), a zip file
  over 200 MB, an entry that expands more than 100 times above 10 MB. Those zip limits are also the cap per answer:
  all unzip calls of one answer together save at most 200 MB and 5,000 files. The unzipped files do not count against
  the turn's write limits one by one (`maxWriteBytesPerTurn` 50 MB, `maxFilesWrittenPerTurn` 200): a project zip of 300
  files is normal (coordinator, PR #1262). Every file still goes through the save checks (write access, skills, the
  wider-audience check, file event).
- **Memory:** at most two unzips run at once on the server (`UNZIP_LIMITS`); another waits up to 20 s, then the AI
  says plainly to try again in a moment. The zip is read inside the slot and let go before any card, and read again
  (same sha256, or refused) for the extraction; each entry is streamed to its work file chunk by chunk, so a call holds
  the zip and a chunk, never a whole inflated entry.
- **Skipped and named:** links and device files, names the team folder does not take, a name that appears twice or is
  both a file and a folder, more than 30 folders deep. Left out silently: `__MACOSX/`, `._*`, `.DS_Store`, `Thumbs.db`,
  `desktop.ini`.
- **Each entry:** inflated on the zlib thread pool with a hard output cap, its real size and CRC compared with the
  directory; a file that fails is named with the files that were saved ("NOT saved: … damaged").
- **Who sees it:** the wider-audience check for the zip's bytes (confirmSources) at the target and at every folder a file
  goes into (existing or not: a rule or share above it decides who reads it), before anything is placed; outside a chat a wider target is refused. Never into a
  skills folder. New folders are recorded once something went in, else removed again.
- **The answer:** the folder linked by its name, how many files with a short list (a summary for many), and plainly
  what was not saved and why. `list_only` lists without saving.
- `zip-guard.ts` now exposes its central-directory reader (`readCentral`, `entryData`, `ZipProblem`) so checkZip and
  unzip_file read zips the same way; checkZip's refusals are unchanged except that its limit numbers now name the limit
  it was called with.
