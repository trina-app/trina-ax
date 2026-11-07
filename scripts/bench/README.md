# Document-question benchmark

Measures how fast and how cheaply the AI answers questions about team documents
(plan `docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md`, steps 1 and 8).

- `docs/`: 22 small made-up documents about a fictional company, Acme (Korean and English mixed; Markdown, text, CSV,
  HTML). No real names or customer data.
- `questions.json`: 30 questions (15 English, 15 Korean; kinds `find`, `answer`, `multi` for two documents). Each has
  `expectFiles` and `expectFacts`. They were written before the first run. Do not change them to fit results; if one is
  wrong, say so in the report and keep the old numbers comparable.
- `run.ts`: uploads the documents to `shared/bench/`, waits until the knowledge graph has indexed them, asks every
  question in a new chat on one engine, writes `results/<out>.json` and `.md`, and deletes `shared/bench/` again (unless
  `--keep-docs`).

Correct = the answer finished and contains every `expectFacts` entry (`a|b` means either; case, spaces and commas are
ignored). "Expected file cited" = the answer's sources list (`/api/chats/:id/messages/:id/sources`) or its text names an
expected file. The correctness check is simple on purpose: read `answer` in the JSON for the wrong ones.

## Run on a local server (what the baseline used)

```bash
D=$HOME/.bench-kg-$RANDOM; P=19377          # pick a free port: lsof -iTCP:$P -sTCP:LISTEN
export TEAM_AX_DEV_DIR=$D TEAM_AX_DEV_PORT=$P
printf '%s\n' 'a-test-password-1' > /tmp/bench-pw          # outside the repo; delete afterwards
bun run dev admin create-owner --username bench-owner --name "Bench Owner" --team Bench < /tmp/bench-pw
bun run dev --no-relay &  echo $! > /tmp/bench-pid         # uses this Mac's Claude Code / Codex login
# wait for http://127.0.0.1:$P/api/setup, then one pass per engine:
bun scripts/bench/run.ts --server http://127.0.0.1:$P --engine claude-code --password-file /tmp/bench-pw \
  --label after-wave-1 --out after-wave-1-claude-code --db $D/data/app.db
bun scripts/bench/run.ts --server http://127.0.0.1:$P --engine codex --password-file /tmp/bench-pw \
  --label after-wave-1 --out after-wave-1-codex --db $D/data/app.db
kill "$(cat /tmp/bench-pid)"; rm -rf "$D" /tmp/bench-pw /tmp/bench-pid   # only that pid, no pkill
```

`--db` reads the turn's own `started_at/dispatched_at` to `ended_at` and `turns.input_tokens/output_tokens` (cache reads
and writes included, the same number the dev server reports). Use `--skip-upload` to rerun on documents already there
(the first run leaves them with `--keep-docs`).

## Run on the dev server (potenlab.trina.app)

No `--db` (no file access): time is wall clock from send to done (polled every 300 ms, so up to 0.3 s coarse) and
tokens are `Message.usage` from the API. Use an owner or admin test account that may pick the engine; put its password
in a file outside the repo. Documents land in `shared/bench/` of that team and are removed at the end. Test data only,
and the dev server needs a fresh OK from the owner for anything beyond this.

```bash
bun scripts/bench/run.ts --server https://potenlab.trina.app --engine claude-code --password-file <file> --label dev-after-wave-1
```

Compare local to local, and dev to dev: the two time sources differ by queue and polling time.

## Notes

- Options: `--only en-01,ko-02`, `--timeout <s>` (default 300; a question that is still running then is stopped and
  counted as not answered), `--username`.
- Everything is sent as the one user, in new chats, so there is no history to carry over. Prompt caching on the engine
  side can make a second pass cheaper than the first; the baseline is one pass.
