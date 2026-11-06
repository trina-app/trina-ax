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

The AI uses both through `knowledge_explore`: one question returns document passages with a link to the place, the
related documents and why, and code symbols with what calls them. It updates itself when people upload, change, move or
delete files. Every answer is filtered by the asking person's folder access at the moment they ask.

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
`tests/security/lib/knowledge-graph-cases.ts`, `web/test/e2e/admin-knowledge-graph.spec.ts`.

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

The indexes hold everything in their folders. What `knowledge_explore` shows is decided at the question, for the person
asking, with the folder rules as they are then. The same rules hold for document passages, related documents and code:

- Only folders the person can see anything in are asked (`RuleSet.canList`). Someone else's personal folder never is.
- Every file the answer names (a passage, a related document, a code match, a caller, a callee) passes `authorize(read)` for that person at that moment, the
  same check as the read tool: folder rules, personal folders (owner only, not admins or the team owner), hidden
  sub-folders inside a readable folder, symbolic links, hard links, quarantined files. A file that fails is left out
  without a trace: no name, no count, no "hidden".
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
- In a team chat room the tool is read-only, and the folders it searched count as read, like `grep` and `search`.
- Confidential chats (safe operations) only have the local file tools, so no `knowledge_explore`. Restricted drafts
  (company profile, skill drafts) have none either.
- Admins see folder paths with file and symbol counts in Admin, never a file or a symbol. Personal folders show only as
  a total. The admin routes are in the permanent permission matrix (admins and the owner only, and no `users/` path in an
  answer).

## The AI tool

`knowledge_explore { query, path?, limit? }`: "Find code, functions and how things connect across the team's files." It
returns up to `limit` (default 8, at most 20) functions, classes and other symbols, each with its path and lines, a link,
its signature, its first lines of code, and for the first three callables what calls them and what they call (by name,
inside the same folder's index). The AI reads the files it needs. It is offered only while the knowledge graph is on.

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
