# The AI reads and searches very long lines to the end

- Date (UTC): 2026-11-18 10:22
- Branch: `fix/read-long-lines`
- Status: in progress
- Where: Team AX core, `server/src/files/` and `shared/src/tools.ts`. Why: the file tools the AI uses live there (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix of the file tools with one new optional `read` input

## Goal

QA TC-4901: with Hacker News exports (a thread .json of 100 KB+ on one line, JSONL posts one per line) the AI said it
only saw the start of each long line, that the lines "dropped out of search", and asked the person to export the data
again. `read` cut every line at 2,000 characters ("… (line cut)") and the AI's grep skipped a matching line whose
ripgrep record was over 64 K characters. A person never has to reformat data for the AI.

## Scope

In:
- `read`: a line longer than what one call shows comes back in pieces, with `char_offset` to go on inside the same
  line ("line 1, characters 0–20,000 of 133,000; read again with offset=1 char_offset=20000"). Every call stays under
  one output budget (characters and the engine's token estimate) and ends with the exact next call.
- `read` of a `.json` file that is one long line: a pretty-printed view by default (`pretty: false` for the raw text);
  `pretty: true` also for `.jsonl` (each record pretty-printed under its line number).
- grep (content mode): a match in a line whose record is over the cap is still reported, as a window around the match
  with its character position in the line and the `read` call that shows it; a long context line is shown as a short
  head. The record cap keeps protecting the memory (the long record is never held).
- Tool descriptions say how to go on reading; the API engine's 30,000-character cut of a tool result says that it cut.

Out: Claude Code's built-in Read is already denied (`CLAUDE_BUILTIN_DENIED`) and Codex has no shell, so nothing there.

## Steps

1. `numberedLines` (files/service.ts): pieces, `char_offset`, output budget, pretty JSON view.
2. `ReadInput` (`char_offset`, `pretty`), FILE_TOOLS descriptions.
3. `runRg` (files/search.ts): an over-long record keeps its head (type, path) and its metadata (line number, byte
   offset, match offsets); grep reads a window around the match from the very file ripgrep searched.
4. api-agent: a cut result says so.
5. Unit tests; a real-AI run on a copy of the QA team.

## Decisions

`docs/decisions/20261118-read-long-lines.md`. It replaces the 2,000-character line cut (stage 1 scaffold, copied from
Claude Code's Read) and changes the grep skip of
[content search limits](../../DECISIONS.md) (R2-ETC-02: a long line is now shown as a window, not skipped).

## Risks

No migration. The output budget makes a plain read of a large normal file stop earlier than 2,000 lines (with the next
offset), where before Claude Code itself cut the result over 25,000 tokens. The file screen's content search also gets
windows for long lines instead of a skip note.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit file read and search tests (133 KB one-line JSON read to the
end, a 50 KB JSONL line, grep for a word at character 120,000, caps hold), a real-AI dev server run.

## Result

(at the end)
