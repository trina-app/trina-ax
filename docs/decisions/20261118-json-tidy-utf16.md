# Long JSON reads stay fast; UTF-16 text reads and greps

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (follows [the AI reads and searches very long lines to the end](20261118-read-long-lines.md))
- Branch: fix/json-tidy-utf16 (QA TC-4950, from the review of #1282)

- **Ask:** two gaps left by the long-line work. (1) The pretty-printed view of a one-line `.json` file was worked out
  again for every piece the AI reads: parse, exact check, reformat and split of the whole file. On an 18 MB file that
  was about 0.77 s a piece, and the view has ~3 million lines (~2,000 pieces), so reading it through kept the server
  busy for over 20 minutes. (2) grep finds text in a UTF-16 file with a byte-order mark (ripgrep reads it as text) and
  names a `read offset=… char_offset=…` call for a long line, but `read` refused the file as binary (zero bytes). A
  UTF-16 file without a byte-order mark is skipped by ripgrep as binary: grep said "No matches" and the AI took the
  text for missing.
- **Decision, read.** The text of a file and its views (its lines, the pretty `.json` view, the `.jsonl` view) are kept
  in one bounded cache per server (`ReadViews`, files/read-lines.ts) by the file's path and the sha256 of its bytes.
  Every read still opens the file through every access check and hashes the bytes it read; only then is the cache
  looked up, so a hit is exactly what those bytes give and nothing reaches a person who could not read the file. A
  changed file has another hash and is read fresh. Values: only texts over one read (`READ_TEXT_CHARS`) are kept; 64 M
  UTF-16 units in all (text plus views), least recently read let go first, a text alone over that is not kept; 10
  minutes idle and it is let go. Kept per server, not per turn: the AI often reads a big file over several turns, and
  the bound is what protects the memory. The first view is cheaper too: the exact check compares without building a
  copy of the text, lines are split once.
- **Security review (2026-11-19).** A view is one string plus a line-start index (4 bytes a line), never an array of
  line strings: a Bun string costs ~30-40 bytes, so 57 pretty views of `[1,1,1,…]` held ~2 GB. Measured now: 60 such
  views grow the heap by ~120 MB. The `.jsonl` view joins whole records (no spread of a record's lines, which
  overflowed the stack on a million values). A cache hit runs the quarantine check and the stop check that
  extraction runs (the size limit is before the cache). A file is taken for UTF-16 without a byte-order mark only with
  zero bytes in at least one byte pair in 16 (and at least two); `write` may replace such a guessed file as before,
  only `edit` and a UTF-16 file with a byte-order mark are refused.
- **Result:** 18 MB one-line JSON, first piece 0.50 s (was 0.82 s), each next piece 18 ms (was 0.77 s)
  (`BENCH_JSON_TIDY=1 bun test tests/unit/files-json-tidy-bench.test.ts`, M1).
- **Decision, UTF-16.** `read` shows UTF-16 text as text: with a byte-order mark (dropped, as ripgrep drops it, so
  lines and character positions agree with grep's), and without one when it is plainly UTF-16 (zero bytes on one side
  of the byte pairs only, no control characters; a binary file has zero bytes on both sides). `edit` and `write` refuse
  a UTF-16 file (write: only with a byte-order mark) as they refuse a legacy encoding: the change would be saved as UTF-8, which the programs using the file
  may not read; the AI writes a UTF-8 copy instead (before, read refused the file, so it could not be changed either).
  grep on one file that finds nothing says when the file is UTF-16 without a byte-order mark and to read it.
- **Not done:** a grep over a folder does not open every file to look for UTF-16 without a byte-order mark (it would
  read the head of every file on each search). A folder grep still skips such files; a grep on the file itself says why.
