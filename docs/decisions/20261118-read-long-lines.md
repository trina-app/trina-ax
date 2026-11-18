# The AI reads and searches very long lines to the end

- Date: 2026-11-18
- Status: accepted
- Supersedes: the 2,000-character line cut of `read` (stage 1 scaffold, 2026-10-21) and the long-line skip of grep in
  [content search limits](../DECISIONS.md) (R2-ETC-02, 2026-10-29)
- Branch: fix/read-long-lines (the owner, QA TC-4901)

- **Ask:** with Hacker News exports (a thread `.json` of 100 KB+ on one line, JSONL posts one per line) the AI said it
  saw only the start of each long line, that those lines "dropped out of search", and asked the person to export the
  data again. The owner: the AI must read such files completely.
- **Where the limits were.** (1) `read` cut every line at 2,000 characters with "… (line cut)" and gave no way to read
  the rest (`numberedLines`, server/src/files/service.ts; written in the stage 1 scaffold 10a9a2ec0 on 2026-10-21 as a
  copy of Claude Code's Read, which also cuts lines at 2,000 characters; no reason was written down). (2) The AI's grep
  dropped a matching line whose ripgrep `--json` record was over 64 K characters (`RG_MAX_RECORD_CHARS`, cffeda4b5 on
  2026-10-29, R2-ETC-02): `--json` ignores `--max-columns`, and a minified file's line must never be held in memory.
  (3) The API engine kept the first 30,000 characters of any tool result without saying so (engine/api-agent.ts,
  13aec78f9, 2026-10-21). Claude Code's own Read is not involved: it is denied (`CLAUDE_BUILTIN_DENIED`), and Codex
  has no shell.
- **Rule: read.** No line is cut. One call shows at most 28,000 characters and about 20,000 tokens of file text (3
  ASCII characters a token, any other character a token; under Claude Code's 25,000-token MCP limit and the API
  engine's 30,000 characters). A line that does not fit comes back in pieces, "[characters 0–27,992 of 140,248]", and
  the result ends with the exact next call: `offset=<line> char_offset=<position>`. The new input `char_offset`
  (0-based, UTF-16 characters, as grep's positions) starts inside the line at `offset`. A many-line file stops at the
  budget with the next `offset`, where before Claude Code cut the result itself.
- **Rule: JSON.** A `.json` file with a line over 2,000 characters, read with no offset, is shown pretty-printed only
  when the reformatted text holds exactly what the file says: its value, re-serialised, must equal the file's text with
  the white space between tokens taken out (`exactJson`). A number over 15 digits, `1.0` or `1e3`, an escape such as
  `\u00e9` or `\/`, a repeated key or invalid JSON keeps the raw text (in pieces). The view's first line says it is a
  reformatted view and that an edit needs the raw text (`pretty: false`); an edit that does not match after such a read
  says so too (`prettyReads`). `pretty: true` asks for the view (a `.jsonl` file per record, a record that would change
  stays raw); text over 20 MB stays raw.
- **Rule: positions.** Character positions are UTF-16 units of the line, as read's `char_offset` counts them; a start
  inside a surrogate pair (an emoji) goes back to the pair, and no piece, window or cut ends or starts inside one.
  ripgrep drops a UTF-8 BOM and read does too, so grep's positions count from after it; CRLF lines end before the CR.
  Empty lines count against the budget (8 characters each for the line number).
- **Rule: grep.** The 64 K record cap stays (memory). An over-long record keeps its head (type, path) and the part after
  the line text (line number, byte offset of the line, the first matches' byte offsets); the line itself is never held.
  After the access checks, grep reads the text around the first three matches from the very file ripgrep searched (the
  admitted snapshot, the office text cache, or legacy Korean / UTF-16 text decoded as ripgrep searched it). The line is
  measured from its UTF-8 bytes in 1 MB pieces through one reused buffer, never decoded whole (a 48 MB one-line file:
  no measurable memory over the search without it, whose own snapshot copy is about 100–150 MB). It shows
  `[line of 200,013 characters; match at character 120,001; read offset=1 char_offset=119801 to see more of it] …text
  around… NEEDLE …text around…`. A long context line shows its first 300 characters. Only a record whose parts cannot
  be read, or a file that changed in between, is still skipped, with a note to read the file. The file screen's content
  search gets the same text around the match, so it now lists such files.
- **Rule: API engine.** A tool result over 30,000 characters says how much was left out and keeps its last 1,000
  characters (where a read says how to go on).
- **Why not raise the 2,000.** Any fixed cut drops data silently for some file; pieces with a next call never do, and
  the per-call budget keeps the context protected.
- **Tests:** tests/unit/files-long-lines.test.ts (a 140 KB one-line JSON read to the end raw and pretty, a 50 KB JSONL
  line, grep for a word at character 120,000 and at 3 MB, a long context line, the budget for many lines, Korean and
  emoji); tests/unit/file-content-search.test.ts (a 3 MB minified line is found).
- **Version impact:** patch.
