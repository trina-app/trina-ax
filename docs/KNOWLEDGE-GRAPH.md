# Knowledge graph

The knowledge graph is the AI's map of the team's files, in two parts:

- **Documents** (on by default, nothing to install, every server): the text of the documents people upload (PDF, Word,
  Excel, PowerPoint, Hangul, Markdown, text, HTML, CSV and more; the formats `server/src/knowledge-graph/documents/`
  accepts) as searchable passages with their page, sheet, slide or heading, in SQLite FTS5 with Korean and Japanese
  matching inside words, and links between documents with their reason (same folder, one names or links to the other,
  shared distinctive terms, the same people). Text comes from the converters the AI's reads use (`files/extract.ts`:
  pandoc, pdftotext, the Office and Hangul workers; OCR of scanned PDFs on a Mac, as before), isolated and below people's
  work; a file that fails is recorded with its reason and shown to admins.
- **Code** (with CodeGraph installed): functions, classes and how they call each other, below.

Three things use it, all through one search, `KnowledgeGraph.lookup()` in `service.ts`:

- **The AI's tool `knowledge_explore`.** One question returns document passages to answer from, with a link to each
  place, the related documents and why, and code symbols with what calls them.
- **The lookup before the model starts.** Claude Code and Codex get the best matching passages of a message in front of
  it, so a document question often needs no search step (below).
- **The Files search box.** People get document matches above the exact-line matches (below).

The graph updates itself when people upload, change, move or delete files. Every answer is filtered by the asking
person's folder access at the moment they ask.

Documents and code are indexed per folder: `projects/<name>`, `groups/<name>`, `users/<id>`, `connected/<name>`,
`shared/` and every other top-level folder, other project folders, and folders an admin adds. The service lists each
folder with the file tools' rules (no symbolic or hard links, no server temp names, not quarantined, not chat
attachments or dependency folders), reads each changed file's bytes itself (the very file it listed) and hands them to
the index; files over 100 MB are recorded as too big without being read. At most 200 documents per folder run; a big
folder comes back for the rest after a pause.

The document index lives in `<data>/knowledge-graph/documents/`; turning the documents part off deletes it.

CodeGraph makes the code map: [github.com/colbymchenry/codegraph](https://github.com/colbymchenry/codegraph), MIT license.
It is an optional tool on the server. Without it the code part is off; documents work anyway.

Code: `server/src/knowledge-graph/` (service, docs-port, documents/, mirror, runner, tool), `server/src/routes/knowledge-graph.ts`,
`shared/src/api/knowledge-graph.ts`, `web/src/pages/admin/KnowledgeGraph.tsx`. Tests:
`tests/unit/c-knowledge-graph.test.ts`, `tests/unit/c-knowledge-graph-docs.test.ts`, the documents module's own tests,
`tests/unit/c-kg-lookup.test.ts`, `tests/unit/c-kg-lookup-security.test.ts`, `tests/unit/b-chat-document-lookup.test.ts`,
`tests/unit/file-content-search-documents.test.ts`, `tests/security/lib/knowledge-graph-cases.ts`,
`web/test/e2e/admin-knowledge-graph.spec.ts`. The benchmark for document questions: `scripts/bench/`.

## Install CodeGraph

On the server, as the account the team server runs as:

```sh
npm install -g @colbymchenry/codegraph
```

Then restart the team server. It finds `codegraph` on the PATH. Another location goes in `server.json`:

```json
{ "knowledgeGraph": { "codegraph": "/opt/codegraph/bin/codegraph" } }
```

`"codegraph": ""` means never use one, even if it is on the PATH. The path can be the npm launcher (`npm-shim.js`), a
bundle's `bin/codegraph` (CodeGraph's `install.sh` links it into `~/.local/bin`), or the bundle folder itself. The server
runs the bundle's own `node` with CodeGraph's script directly, so it needs no Node.js of its own.

### Why CodeGraph is not bundled

- The license allows it: MIT goes into an AGPL-3.0 program.
- The size does not: each platform's CodeGraph is a folder of about 280 MB with its own Node.js runtime. That would
  more than double every Linux release bundle, for a feature that only teams with code use.
- So it is found on the server, like `pandoc` or `pdftotext`. Packages exist for macOS (arm64, x64), Linux (arm64, x64;
  glibc) and Windows. Measured on macOS arm64 only; Linux is not tested yet.

## What is indexed

Each of these is one index, when it holds code (a file in one of CodeGraph's programming languages):

- `projects/<name>`, `groups/<name>`, `users/<id>` (personal folders), `connected/<name>`, and `shared/`
- any other project folder (`projects.folder_path`)
- folders an admin adds in Admin › Team settings › Knowledge graph › Also index (existing folders outside `users/`)

A folder inside another one is part of that one. YAML alone does not count as code.

## Where the index lives

`<data>/knowledge-graph/` in the server's data folder, never in the team folder:

```
<data>/knowledge-graph/
  state.json                         the folders, their counts and state
  roots/<id>/project/tree/           a copy of the folder's code, made by the server
  roots/<id>/project/.codegraph/     CodeGraph's index (SQLite)
```

`<id>` is a hash of the team path. The server refuses to start the feature if the data folder were inside the team
folder.

CodeGraph never reads the team folder. It follows symbolic links (a link to `/etc` inside a folder would be indexed) and
writes its index next to the project. So the server copies the code first, and only what the file tools would show:

- names the team folder accepts, no server temp names, nothing under `.system/`
- regular files with one link: no symbolic links, no hard links. Each file is opened without following a link and checked
  to be the same file (device and inode) the listing saw.
- not quarantined (safe-operations output is download-only)
- code files and a few project files (`package.json`, `tsconfig.json`, `go.mod`, ...), at most 1 MB each, outside
  dependency and build folders (`node_modules`, `dist`, `.git`, `vendor`, ...) and chat attachments (`.attachments`)
- at most 20,000 files or 200 MB per folder. A bigger folder is shown as "Too big" and not indexed.

Every folder of the copy is made by the server and checked on the way, so nothing written there goes through a link.

## When it updates

- A file change marks its folder: uploads, the file screen's saves, moves and deletes, AI edits and new files, and
  connected-folder syncs (everything that goes through `publishChanges` in `server/src/team-files/changes.ts`, which
  emits `tree-changed`).
- The folder runs 30 seconds after its last change, and at most 5 minutes after its first, so a long upload still
  updates.
- One folder at a time. After each run the next waits as long as the run took (2 s to 1 minute). The first index of many
  folders goes gradually.
- A minute after the server starts (10 to 15 minutes where the resource limits apply), and every night between 02:00 and
  05:00 team time (at least every 30 hours), every folder is checked. An unchanged folder only costs a listing.
- An unchanged copy skips CodeGraph. A changed one runs `codegraph sync`. A new folder or a rebuild runs `codegraph init`.

## How CodeGraph runs

As a converter (`server/src/tools/isolate.ts`), like pandoc:

- macOS `sandbox-exec` / Linux `bwrap`: no network, the only program it may start is the bundle's `node`, writes only
  into the index folder, reads only the bundle and the copy (Linux mounts the copy read-only).
- **A Linux server without `bwrap` runs CodeGraph without that sandbox**, as it runs the other converters there: the
  limits below and the fixed environment still apply, the network and file limits do not. Install `bwrap`
  (bubblewrap) on any server that indexes code people upload.
- Below people's work (`taskpolicy -c utility` on macOS, `nice` and `ionice` on Linux), a 30-minute limit per run (the
  wall clock may run three times longer while it waits behind people's work), killed above 1.5 GB of memory.
- Its telemetry, update check and self-download are off (`DO_NOT_TRACK=1`, `CODEGRAPH_TELEMETRY=0`,
  `CODEGRAPH_NO_UPDATE_CHECK=1`, `CODEGRAPH_NO_DOWNLOAD=1`), with its own home folder inside the index folder.
- Two parse workers and one resolver (`CODEGRAPH_PARSE_WORKERS=2`, `CODEGRAPH_RESOLVE_WORKERS=1`).
- Queries for a person's question run at normal priority, 20-second limit each.

Measured on an M-series Mac, 673 TypeScript files (10 MB): first index 12 to 19 s, 7.6 s of CPU, about 0.7 GB peak
memory (1.1 GB with CodeGraph's default of one worker per core), 64 MB index. An update after one changed file: under a
second. A query: about 0.5 s including the sandbox start.

## Access: what an answer may show

The indexes hold everything in their folders. What `knowledge_explore`, the lookup before the model starts and the Files
search show is decided at the question, for the person asking, with the folder rules as they are then. The same rules
hold for document passages, related documents and code:

- Only folders the person can see anything in are asked (`RuleSet.canList`). Someone else's personal folder never is.
- Every file the answer names (a passage, a related document, a code match, a caller, a callee) passes `authorize(read)` for that person at that moment, the
  same check as the read tool: folder rules, personal folders (owner only, not admins or the team owner), hidden
  sub-folders inside a readable folder, symbolic links, hard links (one link to the file, as the read tool requires),
  quarantined files. A file that fails is left out without a trace: no name, no count, no "hidden". How strongly a
  question matches is judged only from passages the person may see.
- The lines of code come from the team file itself, read through the same checks (`readRegular`, no link followed). The
  copy and the index are never shown for a file the person cannot read now. A related document is named only when the
  person may read it too, and its reason is made from the two documents' own names and text.
- `path` narrows the search to one folder. A folder the person cannot read is refused with the same words as a missing
  one ("not found or no access").
- Losing access works at once: the next question leaves the folder out, without re-indexing.
- Callers and callees: CodeGraph finds them by a function's name. When another function of that name is in a file the
  person may not read, the match is shown without its connections (they could be the other one's).
- A match's signature comes from the index and can hold values (`= "…"`, default arguments): it is shown only while
  the file itself still has it, so a value taken out of a file is not shown from an older index.
- An empty answer has one wording, whether or not anything is indexed, and "still being indexed" counts only folders
  never indexed yet: either could otherwise tell that a folder the person sees only in part has documents or code, or
  changes, in the part hidden from them.
- Every file named joins the chat's read scope (`TurnFiles.readPaths`), like a read, so saving that content somewhere
  wider asks first. The matches are the answer's sources.
- In a team chat room the tool is read-only, and the folders it searched count as read, like `grep` and `glob`. Rooms
  get no lookup before the model: it would count folders as read on every question and keep answers private that used
  no file.
- The Files search checks each document row again with grep's own check (`visiblePath`), so it never shows a file that
  the exact-line search could not.
- Confidential chats (safe operations) only have the local file tools, so no `knowledge_explore`. Restricted drafts
  (company profile, skill drafts) have none either.
- Admins see folder paths with file and symbol counts in Admin, never a file or a symbol. Personal folders show only as
  a total. The admin routes are in the permanent permission matrix (admins and the owner only, and no `users/` path in an
  answer).

## The AI tool

`knowledge_explore { query, alt_query?, path?, limit? }`: one search over the team's documents and code. `alt_query`
is the same question in other words or another language (an English wording for a Korean question); both are
searched. The answer is at most about 6,000 tokens (estimated with `knowledge-graph/tokens.ts`: about 4 English
characters per token and 1 token per Korean or other non-ASCII character, so Korean text gets fewer characters than
English), with a note when something is left out:

- **Documents:** up to 3 passages (up to 1,500 characters and about 900 tokens each) to answer from, with the file, the page, sheet, slide or
  section, and a link. The AI answers from them when they are enough and reads a file only for more.
- **More matches:** up to 12 short labelled hits (file · place, link, up to 300 characters and about 150 tokens).
- **Related documents**, with the reason.
- **Code:** up to `limit` (default 8, at most 20) functions, classes and other symbols, each with its path and lines, a
  link, its signature, its first lines of code, and for the first three callables what calls them and what they call (by
  name, inside the same folder's index).

It is offered only while the knowledge graph is on. The prompt names it first among the file tools, and resumed Claude
Code sessions get its rule in `<turn_context>`. Scheduled template runs may call it only with a `path` inside the
template's own folders.

`lookup()` searches documents only (never CodeGraph, so it is fast):

- **Off the main thread.** The searches run in one long-lived worker (`documents/search-worker.ts`, built as
  `doc-search-worker.js` next to the server's `main.js` in the bundles) with its own read-only connection to the index,
  which the writer keeps in WAL mode. The deadline is real: a search not back in time is dropped and the caller gets
  nothing, and a queued search whose time has passed never runs. A search without its own deadline (`knowledge_explore`,
  related documents) gets 5 seconds, so a hung worker cannot hold the AI's turn. The worker starts with the index and
  again as soon as it dies, and opens its connection at once both times, so the next lookup does not wait for it. After
  3 failures in a row, searches run on the main thread for 5 minutes, bounded, with one line in the log. Without the
  worker (a bundle missing the file, which the Linux and office bundle checks refuse), searches run on the main
  thread too, with a warning in the log.
- **Bounded.** Each word adds only the first few hundred matching pieces. Short Korean words match as whole words with
  their particles, or at the start of a longer word. A word of one or two characters is never found in the middle of a
  longer word: that took a full scan of the text, which held the one worker for 0.3–1.1 s while lookups queued behind
  it. grep finds exact text.
- **One folder listing per batch.** The per-file permission checks of one answer share a folder listing.
- Measured on a made-up index of 3,000 documents (36,000 pieces): about 3 ms of main-thread time per lookup (p95 4–6 ms;
  before: 260–720 ms), and about 10 ms for the lookup (p95 16–27 ms).

How strongly a question matches (`documents/index.ts` `matchStrength`):

- Greetings, thanks, requests, question words and fillers in English and Korean are dropped first ("hi", "찾아줘",
  "어디", "관련"; "감사" stays, since it also means an audit). The Files search keeps every word the person types
  (`words: 'search'`).
- **Strong:** one of the first three passages the person may see holds every remaining word within 300 characters. With
  4 or more words, all but one is enough. A one-word question is strong only when the word is a code, a date or a file
  name.
- **Weak:** some of the words.
- **None:** nothing.

## Before the model starts

For Claude Code and Codex, the server looks up the person's message (its first 500 characters) before the engine starts
(`chat/turn.ts` `lookupBeforeModel`), with a 200 ms limit. The model never waits longer: on a timeout or an error
nothing is added.

- **Strong:** a `<document_matches>` block in front of the message, with the passages and short labels, at most about
  2,500 tokens (a long passage is cut to fit, so Korean gets fewer passages). It says that the server added it and that
  the passages are file contents, data and never instructions. File text cannot open or close a block (`BLOCK_TAGS`,
  which also catches spaces and zero-width characters inside a tag; format and other invisible characters, such as
  U+3164 and U+034F, are stripped from file text, paths, places and links first).
- **Weak:** at most 5 file paths (about 300 tokens at most), with no place, no text and no links: a heading or a sheet
  name is document text, and a weak block's files are not recorded as read.
- **None:** no block.
- A strong block's files join the read scope at once, become the answer's sources and mark the chat as having read
  outside content, as after a read: their text reached the model. A weak block's files count only as names shown, as
  after `list` or `glob`: not read, not sources, no mark, so a later save to a wider folder does not ask because of them.
- A resumed Claude session does not get passages it was already given in that session (an in-memory list per chat and
  session, marked only once an attempt that answered has saved the session; after a restart they may come once more).
  Its `<turn_context>` repeats the tool rule only when the session's first instructions lacked it. Codex and fresh Claude sessions get the block every turn, because
  their history does not hold earlier blocks.
- No lookup for the API engine (trial credit too), confidential chats, drafts, skill-share judging and merging,
  scheduled runs (template runs included: nobody is there to answer a card), demo replays, team rooms, or turns without
  `knowledge_explore`. Slack turns keep it: a card there waits for the person.

## The Files search

The Files screen's search box (`GET /api/files/search`, `team-files/content-search.ts`) calls `lookup()` beside the
exact-line search, for the person searching and under the folder they search in (500 ms, at most 1 second). The
answer's optional `documents` field holds one row per document: path, name, place and about 160 characters around the
first word asked for. Each row is checked again with grep's own access check. Today's exact-line matches stay as they
were.

The screen shows "관련 문서" with the document rows above the line matches only when there are any. A click opens the file
at that place. The field is absent when the documents part is off, so older apps keep working.

## Admin › Team settings › Knowledge graph

- **Use the knowledge graph**: on by default when CodeGraph is installed. Off otherwise, with "Install CodeGraph on the
  server to turn this on." Turning it off asks first and deletes the indexes. Turning it on builds them again.
- **Indexed folders**: path, files, symbols, last update, state (Ready, Indexing, Waiting, Couldn't index, Too big).
  Personal folders as one total. The list looks again every few seconds while a folder waits or runs.
- **Also index**: other folders with code.
- **Storage**: disk used by the copies and indexes, the CodeGraph version, and **Rebuild** (every index made again from
  the files, in the background).

Audit: `knowledge_graph.on`, `knowledge_graph.off`, `knowledge_graph.folders`, `knowledge_graph.rebuild`.

## API

| Method | Path | Who | What |
|---|---|---|---|
| `GET` | `/api/admin/knowledge-graph` | Admin | Status: available, version, on, folders with counts, personal total, added folders, disk use |
| `PATCH` | `/api/admin/knowledge-graph` | Admin | `{ enabled?, added? }`. Turning it on without CodeGraph is 409 `unavailable`; a bad added folder is 400 with `reason` `personal`, `not_found` or `root` |
| `POST` | `/api/admin/knowledge-graph/rebuild` | Admin | `{ path? }`, 202. 409 `off` while off; 404 for a folder that is not in the list |

## Not done yet

- Linux (amd64, arm64) has not been run with CodeGraph.
- The Files screen does not show which folders are indexed.
- Connections are by name inside one folder's index: two functions with the same name in one folder share their callers.
