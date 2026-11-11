# Remove the knowledge graph; the AI finds files with list, glob, grep and read again

- Date (UTC): 2026-11-11 01:35
- Branch: `chore/remove-knowledge-graph`
- Status: in progress
- Where: this repo: `server/src/knowledge-graph/` and its callers (chat, tools, MCP, Files search, admin routes),
  `shared/src/api`, the web Files search and Admin › Team settings, the bundle scripts, `scripts/bench/`, docs. Why:
  chat, files and the AI are Team AX core (docs/REPOSITORY-RULES.md).
- Version impact: minor. A feature and an admin API go away (0.x: a breaking change may ship as minor, with an admin
  note); old `server.json` files, old chats and old schedules keep working.

## Goal

The product owner decided on 2026-11-11 to remove the knowledge graph completely. The in-app AI (Claude Code or Codex
on the team's server) finds files with its own tools again: `list`, `glob`, `grep` and `read`.

Why:

- On the same dev build with the knowledge graph on and off, the AI found the same files either way (a 2,204-file test
  folder, the 92 questions that finished).
- The index alone put the right file in its top 5 for only 28% of hard questions; a plain file-name search got 57%.
- It saved about 27% of input tokens on easy questions, and used more on others.
- A confirmed stale-text leak: text removed from a file stayed searchable, and the AI quoted it, until the folder was
  indexed again (30 s to overnight).
- After every restart on Linux nothing was indexed for 10–15 minutes.
- On a 4 GB server searches slowed to 1–7 s while indexing, and the meaning indexer went over its 800 MiB cap.
- Anthropic's guidance: start with agentic search; semantic search is "less accurate, more difficult to maintain". The
  Claude Code team found grep and glob beat vector databases and indexing ("stale indexes, permission complexity").

## Scope

Goes:

- `server/src/knowledge-graph/` as a whole: the document index (SQLite FTS5) and its search worker, search by meaning
  (multilingual-e5-small, the embedding process), the CodeGraph code map (mirror, runner), the `knowledge_explore` tool.
- The lookup before the model (`chat/turn.ts`: the `<document_matches>` block, the per-session memory of passages given)
  and its prompt notes (`chat/prompt.ts`: `KNOWLEDGE_RULE`, `TEMPLATE_KNOWLEDGE_RULE`, `DOCUMENT_STRONG_NOTE`,
  `DOCUMENT_WEAK_NOTE`, the tool's name in the file rule and the source-link rule, the `<turn_context>` rule).
- `knowledge_explore` in the room tool lists, the read-only and parallel tool lists, the search tools a room counts as
  read, the scheduled template's tool checks.
- The Files search's document rows ("관련 문서", `FileContentHits.documents`) and its knowledge graph lookup.
- Admin › Team settings › Knowledge graph, `GET/PATCH /api/admin/knowledge-graph`,
  `POST /api/admin/knowledge-graph/rebuild`, `shared/src/api/knowledge-graph.ts`, the `kg.*` labels in five languages.
- `scripts/vendor-semantic.ts`, the meaning runtime in the office and Linux bundles, the `@huggingface/transformers`
  dependency (and with it `onnxruntime-node` and `sharp`, which nothing else uses), `onnxruntime-node` in
  `versions.json`.
- `scripts/bench/quality/` (a test of the index only) and the benchmark results of the knowledge graph waves. The
  document-question benchmark (`scripts/bench/run.ts`) stays, without its wait for the index.
- `docs/KNOWLEDGE-GRAPH.md`, and every link to it.

Stays:

- The Files search box: names and exact-line matches through the existing grep path, as before the knowledge graph. A
  word no file has says "nothing found" (PR #292's behaviour). PR #308's model refusal goes with search by meaning.
- The MCP connection's parallel read-only calls (`list`, `glob`, `grep`, `read`), which came with the knowledge graph
  but are not part of it.
- The old `search` tool stays removed.

## Steps

1. This plan.
2. Server: delete the module, the tool, the lookup, the prompt notes, the routes and the shared types; Files search
   back to lines only.
3. Old configs and data:
   - `server.json` with `knowledgeGraph` still loads: the key is accepted with any value, ignored and logged once as
     obsolete. (Its own sub-object was strict; the top level strips unknown keys, so the key stays in the schema only
     so that the start can say so.) CONFIGURATION.md says so.
   - On start, `<data>/knowledge-graph/` is deleted once (it holds copies of private document text), with one log line.
   - The downloaded model folder `<data>/models/Xenova/multilingual-e5-small` (and an empty `Xenova/` above it) is
     deleted the same way: nothing else uses it (whisper keeps `<data>/models/whisper`). A host's read-only
     `$MYCEL_MODELS_DIR` is never touched.
   - The switch's settings rows (`knowledgeGraph.enabled`, `.documents`, `.added` in `settings`) go with a new
     migration (339). Old migrations stay as they are.
4. Old content:
   - Chats with `knowledge_explore` steps still show them: its step label and summary stay (like the removed
     `search`), and it stays on the team-content list that keeps such old steps from marking a chat as outside.
   - Old audit rows keep their labels (`audit.act.knowledge_graph.*`).
   - Scheduled templates never stored a tool list: their scope is two folders, and the tool checks list `read`, `list`,
     `glob`, `grep` and `write`. A run that names an unknown tool gets the template's refusal, as before.
5. Web: Files search without document rows; no knowledge graph section in Team settings; mock server and specs.
6. Build: no meaning runtime in the bundles; the dependency and lock file.
7. Bench: remove the quality test and the knowledge graph results.
8. Docs: DECISIONS (2026-11-11), `changes/remove-knowledge-graph.md`, CONFIGURATION, TRY-IT, the docs site, the API
   reference.

## Risks

- Migrations: the highest on `dev` is 338, so this one is 339. It only deletes settings rows (reader level unchanged:
  an older build reads no row and uses its default).
- Permissions: removing a search path can only show less. The security cases of the knowledge graph go; the Files search
  cases stay for the line matches.
- An admin's open Team settings page from an older web app calls the removed endpoint: it shows an error until reload.
  The desktop and phone apps load the web app from the server.
- Five languages: the removed labels go from every language; `bun run check:i18n` must stay at 0.
- Bundles: the Linux bundle no longer carries `node_modules/` for the meaning runtime; the bundle checks must still pass.

## Tests

- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`.
- Server unit tests for chat, prompt, tools, MCP, team files, schedules, admin, config, rooms, and `tests/security`,
  compared with a run on untouched `origin/dev`.
- New tests: the old data folder and model deleted once with one line (a host's shared folder untouched); an old
  `server.json` with `knowledgeGraph` loads and logs once; the migration removes the rows; an old chat's
  `knowledge_explore` step still has its label.
- Web e2e: the Files search, admin and settings specs.
- A real start on a data folder with a `knowledge-graph/` folder: deleted with one line, a chat finds a file with
  Claude Code, the Files search works.

## Result

Filled in at the end.
