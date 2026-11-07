# The AI answers document questions from the knowledge graph, faster and cheaper

- Date (UTC): 2026-11-07 08:19
- Branch: `feat/knowledge-graph-fast-answers`
- Status: draft
- Where: this repo, `server/src/knowledge-graph/`, `server/src/chat/` (prompt, turn), `server/src/mcp/`, and the old
  `server/src/search/` it replaces. Why: chat, files and the AI belong in the Team AX core (docs/REPOSITORY-RULES.md).
- Version impact: minor. New behaviour that nobody has to set up; nothing that worked before stops working.

## Goal

When someone asks Trina's AI about the team's documents ("where did we write X?", "what do our documents say about
Y?"), it should answer from the knowledge graph instead of searching, reading and searching again.

Measured on the dev server (10 days of test traffic, 74 question turns):

- Questions that searched or read files took **13.8 s** at the median and used about **52,000 input tokens**.
  Questions that touched no files took 7.1 s and about 20,000 tokens.
- The tools themselves take about 0 s. The time goes to model round trips, about 3.5 per answer.
- `knowledge_explore` was called twice. The prompt's file rule does not name it, continued Claude Code chats lose its
  rule, and nothing is looked up before the model starts.

Targets, for a fixed set of about 30 document questions on test data, on Claude Code and Codex:

- median answer time **7 s or less**
- median input **25,000 tokens or less**
- correct answers no worse than today

Keep it simple: one index (the knowledge graph's `documents.db`), one tool (`knowledge_explore`), no new admin
screen, no new server tables, no SQLite extension, no reranking model and no outside service.

## Scope

In:

- Claude Code and Codex on the team's own server, in every place the AI answers: personal chat, team rooms,
  sub-agents, Slack and scheduled turns, and scheduled template runs.
- Phase 1: how the AI uses the index.
- Phase 2: search by meaning inside the same index.
- Phase 3: search by meaning on by default, and the old `search` tool removed.

Out:

- The API engine (trial credit): no lookup before the model starts and no prompt change. It calls the same
  `knowledge_explore`, so it does see the new result format. Keeping the old format for it would need a second code path.
- Confidential (safe operations 1A) chats and drafts: unchanged.
- Trimming the fixed prompt, which costs about 18,000–20,000 tokens on every model step. That gets its own plan.
- One shared copy of the extracted text for grep, read and the index. Today Office, PDF and Hangul text is extracted
  twice.
- Code search (CodeGraph), chats and room messages in the index, paid embedding APIs, larger models, and an admin
  control for search by meaning.

## Steps

Phase 1: the AI uses the index first (no embeddings yet)

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
7. Run the benchmark again on the dev server and write the numbers into this plan.

Phase 2: search by meaning, off by default

8. Model: `multilingual-e5-small` (MIT). The server downloads it on first use, checks its pinned hashes and stores it in
   `<data>/models`, or uses the host's shared model folder, as the old search did. A server without internet stays on
   keyword search.
9. Each piece of text is embedded with its file name and heading in front. Korean Excel CSV files (CP949) are decoded
   the way grep decodes them.
10. Vectors go into a new column of the pieces table in `documents.db`, stored as int8 and held in memory (about 38 MB
    per 100,000 pieces). No SQLite extension.
11. Search always combines keyword and meaning results by rank (reciprocal rank fusion). Meaning results are never used
    alone. If the meaning part is not ready within step 4's 200 ms, it is left out for that message.
12. Indexing uses one worker, runs below people's work, pauses while someone is waiting for an answer, and uses about
    800 MB of memory at most. It starts only with about 1.5 GB of memory free. Otherwise it logs one line and tries
    again at the nightly check. A large folder's first pass can take hours; keyword search works in the meantime.
13. Switch: `knowledgeGraph.meaning` in `server.json`. In this phase it is off unless set, and only the dev server sets
    it. Nothing in the admin screen.
14. Quality test, written before any run:
    - 100–150 Korean and English questions: paraphrases, exact names, numbers in tables and CSV files,
      Korean ↔ English, and file names.
    - Documents: public documents downloaded by a script, plus the 35-file made-up office.
    - Measure keyword-only against combined: is the right file in the top 8, and is it first?
    - The questions and expected files go into the repo; the documents never do.

Phase 3: on by default

15. If the combined search beats keyword-only overall and is not worse on any type of question, search by meaning is
    on by default (`knowledgeGraph.meaning: false` turns it off). If it does not pass, it stays off and the result
    goes into docs/DECISIONS.md.
16. Remove the old `search` tool, `server/src/search/semantic.ts` and their tests, and delete the old
    `<data>/semantic.db` on start. The bundled runtime and the downloaded model stay, because step 8 uses them.
17. Update docs/KNOWLEDGE-GRAPH.md and docs/DECISIONS.md, including the tool description that still says "code only".

Each step is a small PR into `dev` (minor), tested on the dev server.

## Risks

- Access:
  - The lookup before the model runs as the person asking, with the folder rules as they are at that moment: every
    file passes `authorize(read)`, as in `knowledge_explore`.
  - It never reads folders the person cannot see, and nothing is cached across people.
- Tokens:
  - The lookup adds tokens to messages that are not about documents. The strong and weak thresholds are tuned with the
    benchmark.
  - Continued chats keep earlier passages in their history.
- Parallel tool calls: each call keeps its own result and its own audit row (`tool_events`). Writes stay serial.
- CPU on small servers: 2-core Lightsail plans guarantee only 20% of each core, so indexing must stay below people's
  work (step 12).
- Memory: the model holds 150–300 MB. The old index peaked at 1.9 GB on a large folder. Batches of 4 were measured at
  0.8 GB.
- Model download: it comes from Hugging Face at a pinned revision with checked hashes. Servers without internet stay
  on keyword search.
- `documents.db` gets a new column. An existing index adds it on start, so no server migration number is used.
- Languages: no new user-facing text is planned. If any appears, it goes into all five app languages.
- Codex: the lookup goes into its instructions on stdin. Every benchmark runs on both engines.

## Tests

- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`.
- Unit tests: `tests/unit/c-knowledge-graph*.test.ts`, `tests/unit/c-kg-documents.test.ts`, plus new tests for:
  - the lookup before the model starts: each person's access, strong, weak and no match, no repeats, the 200 ms limit
  - the new result format
  - parallel read-only calls, with writes still serial
  - rank fusion and CP949 decoding
  - the memory limit for vectors, the switch, and the free-memory check
- Security: extend `tests/security/lib/knowledge-graph-cases.ts` to the lookup before the model starts. A hidden
  folder must never appear in the prompt.
- The benchmark (phase 1) and the quality test (phase 2) on the dev server, with test data only.

## Result

To be filled in at the end.
