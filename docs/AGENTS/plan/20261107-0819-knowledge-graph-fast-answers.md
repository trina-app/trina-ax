# The AI and the Files search answer from the knowledge graph, faster and cheaper

- Date (UTC): 2026-11-07 08:19
- Branch: `feat/knowledge-graph-fast-answers` (wave 1, PR #165); `feat/knowledge-graph-meaning` (waves 2 and 3, stacked
  on wave 1)
- Status: in progress (wave 1 in PR #165; waves 2 and 3 being built)
- Where: this repo, `server/src/knowledge-graph/`, `server/src/chat/` (prompt, turn), `server/src/mcp/`, the Files
  search (`server/src/routes/files.ts`, `web/src/components/FileContentSearch.tsx`), and the old `server/src/search/`
  it replaces. Why: chat, files and the AI belong in the Team AX core (docs/REPOSITORY-RULES.md).
- Version impact: minor. New behaviour and a visible change to the Files search that nobody has to set up; nothing
  that worked before stops working.

## Goal

The files people upload to the team folder (`groups/`, `projects/`, `shared/`, `skills/`, `users/`) are already in the
knowledge graph. They are indexed after every upload, save, move or delete. Two things should use that index:

- **Trina's AI.** When someone asks about the team's documents ("where did we write X?", "what do our documents say
  about Y?"), the AI answers from the knowledge graph instead of searching, reading and searching again.
- **People.** The search box on the Files screen finds documents through the knowledge graph too, not only exact words
  line by line.

Permissions work exactly as before: a person and the AI acting for them only ever see files that person may open.

Measured on the dev server (10 days of test traffic, 74 question turns):

- Questions that searched or read files took **13.8 s** at the median and used about **52,000 input tokens**.
  Questions that touched no files took 7.1 s and about 20,000 tokens.
- The tools themselves take about 0 s. The time goes to model round trips, about 3.5 per answer.
- `knowledge_explore` was called twice. The prompt's file rule does not name it, continued Claude Code chats lose its
  rule, and nothing is looked up before the model starts.

Targets for the AI, for a fixed set of about 30 document questions on test data, on Claude Code and Codex:

- median answer time **7 s or less**
- median input **25,000 tokens or less**
- correct answers no worse than today

Keep it simple: one index (the knowledge graph's `documents.db`), one search used by the AI and by the Files screen,
no new screens or buttons, no new server tables, no SQLite extension, no reranking model and no outside service.

## Scope

In:

- Claude Code and Codex on the team's own server, in every place the AI answers: personal chat, team rooms,
  sub-agents, Slack and scheduled turns, and scheduled template runs.
- The search box on the Files screen, for people.
- Wave 1: the AI and the Files search use the index.
- Wave 2: search by meaning inside the same index.
- Wave 3: search by meaning on by default, and the old `search` tool removed.

Out:

- The API engine (trial credit): no lookup before the model starts and no prompt change. It calls the same
  `knowledge_explore`, so it does see the new result format. Keeping the old format for it would need a second code path.
- Confidential (safe operations 1A) chats and drafts: unchanged.
- A view that shows people how files connect (related documents and why).
- Trimming the fixed prompt, which costs about 18,000–20,000 tokens on every model step. That gets its own plan.
- One shared copy of the extracted text for grep, read and the index. Today Office, PDF and Hangul text is extracted
  twice.
- Code search (CodeGraph), chats and room messages in the index, paid embedding APIs, larger models, and an admin
  control for search by meaning.

## Steps

Wave 1: the AI and the Files search use the index (no embeddings yet)

1. Benchmark first. A script in `scripts/bench/` sends about 30 Korean and English questions about test documents to a
   server. Answer time comes from `turns` and the stored steps, tokens from `turns`. Record today's numbers on the
   dev server.
2. `knowledge_explore` returns 3 long passages (about 1,500 characters each) to answer from, plus about 12 short
   labelled hits (file name, heading, about 300 characters), with links: about 6,000 tokens at most. It accepts a
   second wording in the same call, so a Korean question can also search in English.
3. Prompt (`chat/prompt.ts`):
   - The file rule ("Team files are available ONLY through …") names `knowledge_explore` first.
   - The source-link rule covers its links.
   - Continued Claude Code chats get the rule in `<turn_context>`.
4. Lookup before the model starts (`chat/turn.ts`, before the engine launches), for Claude Code and Codex only. The
   server searches the message with the asking person's access, within 200 ms:
   - Strong match: about 2,500 tokens of passages go into the turn's context.
   - Weak match: about 5 file names with their headings (about 200 tokens).
   - Nothing found: nothing goes in.
   - In a continued chat, passages already given in that chat are not given again.
   - Files given this way count as read and as sources, exactly as after a tool call.
5. One answer's read-only tool calls (read, list, glob, grep, `knowledge_explore`) run in parallel on the MCP
   connection (`mcp/socket.ts`). Writes and edits still run one at a time, in order.
6. Scheduled template runs may call `knowledge_explore` (`chat/schedule-templates.ts`).
7. The Files search box (`GET /api/files/search`, `web/src/components/FileContentSearch.tsx`) uses the knowledge graph
   too, with the same box and no new buttons:
   - Document matches come first: one row per document, with the best passage and its page, sheet or heading. A click
     opens the file.
   - Exact-line matches follow as today, so nothing that is found today goes missing (for example code files, or a
     file changed in the last 30 seconds that is not indexed yet).
   - The response gets one new optional field for the document matches, so older apps keep working.
   - Permissions are the same as today's search and the AI's: only files the person may open at the moment they
     search, with the same per-person rate limit. Files are checked one by one with `authorize(read)`, which covers
     folder rules, other people's personal folders, hidden sub-folders inside a readable folder, links and
     quarantined files.
   - After wave 2, the same box also finds by meaning, with no further change.
8. Run the benchmark again on the dev server and write the numbers into this plan.

Wave 2: search by meaning, off by default

9. Model: `multilingual-e5-small` (MIT). The server downloads it on first use, checks its pinned hashes and stores it in
   `<data>/models`, or uses the host's shared model folder, as the old search did. A server without internet stays on
   keyword search.
10. Each piece of text is embedded with its file name and heading in front. Korean Excel CSV files (CP949) are decoded
    the way grep decodes them.
11. Vectors go into a new column of the pieces table in `documents.db`, stored as int8 and held in memory (about 38 MB
    per 100,000 pieces). No SQLite extension.
12. Search always combines keyword and meaning results by rank (reciprocal rank fusion). Meaning results are never used
    alone. If the meaning part is not ready within step 4's 200 ms, it is left out for that message.
13. Indexing uses one worker, runs below people's work, pauses while someone is waiting for an answer, and uses about
    800 MB of memory at most. It starts only with about 1.5 GB of memory free. Otherwise it logs one line and tries
    again at the nightly check. A large folder's first pass can take hours; keyword search works in the meantime.
14. Switch: `knowledgeGraph.meaning` in `server.json`. In this wave it is off unless set, and only the dev server sets
    it. Nothing in the admin screen.
15. Quality test, written before any run:
    - 100–150 Korean and English questions: paraphrases, exact names, numbers in tables and CSV files,
      Korean ↔ English, and file names.
    - Documents: public documents downloaded by a script, plus the 35-file made-up office.
    - Measure keyword-only against combined: is the right file in the top 8, and is it first?
    - The questions and expected files go into the repo; the documents never do.

Wave 3: on by default

16. If the combined search beats keyword-only overall and is not worse on any type of question, search by meaning is
    on by default (`knowledgeGraph.meaning: false` turns it off). If it does not pass, it stays off and the result
    goes into docs/DECISIONS.md.
17. Remove the old `search` tool, `server/src/search/semantic.ts` and their tests, and delete the old
    `<data>/semantic.db` on start. The bundled runtime and the downloaded model stay, because step 9 uses them.
18. Update docs/KNOWLEDGE-GRAPH.md and docs/DECISIONS.md, including the tool description that still says "code only".

Each wave is one PR into `dev` (minor), tested on the dev server. Inside a wave, agents work in parallel on separate
files. They share one search, `KnowledgeGraph.lookup()` in `server/src/knowledge-graph/service.ts`, which the
knowledge-graph agent owns and the others call: the AI's tool, the lookup before the model starts and the Files
search. Wave 1 agents: benchmark; knowledge graph (`lookup`, the tool); chat (prompt, the lookup before the model,
template runs); MCP (parallel reads); Files search (route, screen, languages).

Wave 2 agents, around one contract (`server/src/knowledge-graph/meaning/vectors.ts`: the model, the int8 vector format,
the embedder interface):

- **Meaning index:** the embedder, indexing in a background process, the `vec` column, CP949, file name and heading
  in front, the memory check, the switch.
- **Combined search:** the vectors in the search worker, the query's embedding, rank fusion with the keyword results,
  the deadline.
- **Quality test:** the public documents and the made-up office, 100–150 questions written before any run, and the
  runner.

Wave 3 follows the quality test's result.

## Risks

- Permissions, which must not change:
  - The lookup before the model and the Files search run as the person asking, with the folder rules as they are at
    that moment: every file passes `authorize(read)`, as in `knowledge_explore`.
  - They never read folders the person cannot see, and nothing is cached across people.
  - The Files search must not show anyone a file that today's search would not show them. The security cases run
    against the new document matches as well as the AI's lookup.
- Tokens:
  - The lookup adds tokens to messages that are not about documents. The strong and weak thresholds are tuned with the
    benchmark.
  - Continued chats keep earlier passages in their history.
- Parallel tool calls: each call keeps its own result and its own audit row (`tool_events`). Writes stay serial.
- CPU on small servers: 2-core Lightsail plans guarantee only 20% of each core, so indexing must stay below people's
  work (step 13).
- Memory: the model holds 150–300 MB. The old index peaked at 1.9 GB on a large folder. Batches of 4 were measured at
  0.8 GB.
- Model download: it comes from Hugging Face at a pinned revision with checked hashes. Servers without internet stay
  on keyword search.
- `documents.db` gets a new column. An existing index adds it on start, so no server migration number is used.
- The Files screen:
  - Any new label goes into all five app languages.
  - Check it at phone width and in dark mode.
- Codex: the lookup goes into its instructions on stdin. Every benchmark runs on both engines.

## Tests

- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`.
- Unit tests: `tests/unit/c-knowledge-graph*.test.ts`, `tests/unit/c-kg-documents.test.ts`, plus new tests for:
  - the lookup before the model starts: each person's access, strong, weak and no match, no repeats, the 200 ms limit
  - the new result format
  - parallel read-only calls, with writes still serial
  - the Files search's document matches
  - rank fusion and CP949 decoding
  - the memory limit for vectors, the switch, and the free-memory check
- Security: extend `tests/security/lib/knowledge-graph-cases.ts` and the `/api/files/search` cases in
  `tests/security/lib/cases.ts`. A file the person may not open must never appear in the prompt or in the Files search,
  whether it is in another person's folder, in a hidden sub-folder, behind a link or quarantined.
- The full web e2e, because the Files screen changes.
- The benchmark (wave 1) and the quality test (wave 2) on the dev server, with test data only.

## Result

Wave 1 (built 2026-11-07; waves 2 and 3 are still to come):

- Built as planned. Five parallel agents worked on separate files around one `KnowledgeGraph.lookup()`.
- An independent review found two must-fix problems, and both were fixed and re-reviewed:
  - the document search held the server's main thread;
  - name-only matches widened the read scope.
- Differences from the plan:
  - Team rooms and scheduled runs get no lookup before the model.
  - Weak matches show file names only.
  - Budgets are in tokens, not characters.
  - Document searches run in one worker thread.
  - The slow full scan for one- and two-letter words was removed (grep still finds exact text).
- Benchmark on this Mac with real AI: 30 questions over 22 made-up documents, one pass each. Times and tokens come from
  the turns table, with cached tokens included in input.

  | Engine | Median time | p90 | Median input tokens | Median tool calls | Correct |
  |---|---|---|---|---|---|
  | Claude Code, before | 7.4 s | 10.0 s | 116,964 | 2 | 30/30 |
  | Claude Code, after | 6.9 s | 8.6 s | 80,469 (−31%) | 1 | 30/30 |
  | Codex, before | 10.5 s | 16.2 s | 76,564 | 2 | 30/30 |
  | Codex, after | 7.9 s (−25%) | 14.4 s | 57,949 (−24%) | 1 | 29/30 |

  - The one miss was an English question about a report written in Korean. The rule now says to try the other
    language and file names when nothing is found. Three reruns found it two times.
  - The 7 s and 25,000-token targets were set from the dev server, whose fixed prompt is smaller than this Mac's. The
    dev-server run (step 8) waits for a test account and the owner's OK.
- PR: https://github.com/trina-app/trina-ax/pull/165
