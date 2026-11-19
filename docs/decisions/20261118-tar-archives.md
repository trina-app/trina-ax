# Tar archives in unzip_file and make_zip

- Date: 2026-11-18
- Status: accepted
- Supersedes: the "only .zip" lines of [20261118-unzip-file.md](20261118-unzip-file.md) and
  [20261118-make-zip-and-mail-attachments.md](20261118-make-zip-and-mail-attachments.md)
- Branch: feat/tar-archives (QA TC-5057)

- **Ask:** the AI refused a .tar.gz ("only .zip files can be unzipped here") and could only make .zip files. Claude Code
  just runs `tar`. Claude Code is the floor, so both tools take tar now.
- **unzip_file:** opens .zip, .tar, .tar.gz / .tgz and a lone .gz. The kind comes from the bytes, not the name (zip
  magic, gzip magic, a tar header with a correct checksum); a gzip that holds a tar is a tar. A lone .gz is one file,
  named after the .gz without ".gz" (as `gunzip` does; the name stored inside the gzip is not used) and saved next to
  it, like an email's attachments. A file named .tar/.gz/.tgz whose bytes are not that kind says so.
- **Same rules as a zip, through the same code:** a tar's entries become the same raw list as a zip's and go through
  `files/unzip.ts planEntries`: an absolute path, a drive letter or ".." refuses the whole archive (also when it comes
  from the ustar prefix field, a GNU long name or a pax `path`); junk left out; names the team folder does not take,
  too deep paths and duplicates skipped and named. Symlinks, hard links, character and block devices, FIFOs, vendor
  types and pax sparse files are skipped and named (never followed or made). The extraction, the per-file save
  (placeProduced), the instruction-name rename (CLAUDE.md → "CLAUDE (2).md"), the wider-audience cards, the skills
  refusal, the per-answer budget and the guests' own per-answer limits are the zip path's code, unchanged.
- **Bounds (files/tar.ts):** every header's checksum is checked; numbers must be octal digits or GNU base-256 (no
  negative); every size, including a pax `size`, must fit in what is left of the archive ("cut short" otherwise); pax
  records must have exactly their stated length; a pax header or GNU long name is at most 1 MB, a pax header holds at
  most 256 records, and at most 32 such headers may come in a row before an entry (security review of #1345: 4,000 pax
  headers stalled the server for two minutes); of pax keys only `path`, `size` and a GNU sparse flag are kept, merged in
  place; the ustar prefix field is read only in POSIX headers (`ustar\0`; old GNU keeps times there); at most 5,000 entries
  and 200 MB of files (the zip limits). Old GNU sparse ('S') and multi-volume ('M') tars are refused. A gzip is
  unpacked as a stream and stopped as soon as it passes 232 MB (200 MB of files plus room for headers) or, above
  10 MB, 100 times its packed size: the zip's expansion rule, so a gzip bomb never fills memory. The unpacked tar is
  held in memory inside the server-wide unzip slot, as a zip is, and unpacked again for the extraction after the
  cards (the packed bytes' sha256 must match the planned one).
- **make_zip:** keeps its name (it is in the shared-chat, room, guest and step-label lists, and the AI finds it by "zip";
  no rename pattern exists). New optional `format`: zip (default), tar, tar.gz or tgz; or the ending of `output`
  (.tar, .tar.gz, .tgz). Both given and disagreeing is refused. The walk, the permission checks, the inode check, the
  limits, the card and the save path are the zip's. Written by `files/tar.ts TarStream` with the backups' header
  blocks (`system/tar.ts tarHeaders`: pax `path` and `mtime`, so Korean and long names open in GNU tar, bsdtar and
  7-Zip); a file that grows or shrinks while it is read stops the archive (its size is in the header before its bytes),
  nothing saved.
- **Why our own reader:** no tar library is a server dependency (`tar` and `tar-stream` are only in the build tools'
  tree), and no new native install is wanted. `system/tar.ts readTar` (backups) fails a whole archive on any link and
  reads UTF-8 names only; people's archives need the zip's skip-and-name rules and Windows' CP949 names.
- **Left open:** .7z and .rar (no small pure-JS or bundled reader in the tree, and both formats are large;
  rar is a closed format), .tar.bz2 and .tar.xz (no decoder in node:zlib), .tar.zst (node:zlib
  has zstd; can be added the same way if asked).
