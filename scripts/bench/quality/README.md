# Search quality test: keyword-only against combined search

Decides whether search by meaning goes on by default (plan `docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md`,
wave 2 step 15 and wave 3 step 16; docs/DECISIONS.md "Search by meaning off by default (2026-11-01)"). Wave 3 turns the
combined search (keyword plus meaning, fused by rank) on by default only if it beats keyword-only overall and is not
worse on any type of question.

## Files

- `docs/`: 27 made-up Acme documents, added to the 22 of the wave 1 benchmark (`scripts/bench/docs/`): 49 targets.
  Korean and English; an English contract and employment template that Korean questions ask about; Korean reports
  (survey, warehouse move, board minutes, monthly results) that English questions ask about; tables with numbers; two
  Korean Excel CSVs saved as CP949 (`부서별-예산-2027.csv`, `재고현황-2026-10.csv`) and one UTF-8 CSV with a BOM; file
  names that say what the file is. All names are made up.
- `questions.json`: 150 questions, 75 Korean and 75 English, 30 of each type. Written and committed (1e9cfe32) before
  the runner existed and before any search ran. Never change them after seeing results; if one is wrong, say so in the
  report and keep it.
  - `paraphrase`: none of the document's own words (checked: no word the AI's lookup takes from the question is in the
    expected document, a part of a word counting as the index matches it). Keyword-only cannot find these by design.
  - `exact`: a name, code or number. `table`: numbers in a table or CSV. `filename`: the question names what the file is.
  - `cross`: a Korean question to an English document or the reverse. Keyword-only finds these only through shared
    numbers or Latin names.
- `check.ts`: validates `questions.json` against the documents' text only (no search).
- `fetch.ts`, `distractors.json`: the public distractors. About 3,000 Wikipedia articles (1,500 Korean, 1,500 English;
  half from office-topic seed words such as lease, leave, invoice, security, sensor, the hard ones, half general). The
  committed list holds titles and page ids only; the text goes to `.cache/wiki/`, which git ignores. Never commit it.
- `run.ts`: the runner. `meaning.ts`: every part that depends on the wave 2 code, in one place. `lib.ts`: shared paths.
- `docker.sh`: the runner inside Docker with 2 CPUs and 4 GB. `results/`: JSON and Markdown per run (ids, file paths and
  numbers only, never document text).

## Run

```bash
bun scripts/bench/quality/check.ts                 # the questions against the documents, no search
bun scripts/bench/quality/fetch.ts                 # once: about 45 minutes, two wikis side by side, one request at a time each
bun scripts/bench/quality/run.ts --modes keyword --out 2026-11-07-keyword-mac
```

`run.ts` builds a temporary index with the server's own `DocumentIndex` and extraction (`files/extract.ts`, CP949 like
grep), every file in a fixed shuffled order (sha256 of its path): the full-text index takes the first few hundred matches
of a word unranked, by row order, so targets must not all come first. It then copies the index for the smaller sizes
(about 50 and 500 files: the 49 targets plus the first distractors in the same order) and takes the other files out
again. Every question goes through `DocumentIndex.search` the way the AI's lookup sends it (`service.ts` docPassages:
the question's distinctive words, `questionTerms`, joined; limit 45; passages of 1,500 characters). `--words search`
sends every word instead, as the Files search box does.

Options: `--modes keyword,combined` (default both; combined is skipped with the reason when it cannot run),
`--sizes 50,500,full`, `--max-distractors <n>`, `--out <name>`, `--label <text>`, `--keep <dir>` (keep the index),
`--bootstrap <n>` (default 10,000).

### Meaning mode, once wave 2 is merged

`run.ts` runs combined mode when all of these are there, and says which is missing otherwise:

1. `documents.db` has the `chunks.vec` column (the meaning index adds it when the index opens).
2. `openEmbedder()` (`server/src/knowledge-graph/meaning/embedder.ts`) opens the model. It is downloaded on first use
   into `--model-dir` (default `scripts/bench/quality/.cache/models`), or found in `$MYCEL_MODELS_DIR/semantic`.
3. The runner embeds every piece without a vector as `passageText(file name, heading, text)` (`meaning/vectors.ts`),
   `quantize`, `vecToBlob`, and an UPDATE of `chunks.vec`; `--embed-threads` (default min(4, cores)) and
   `--embed-batch` (default 16). Use `--embed-threads 1` to measure what the server's one background worker would do.
4. Each question is searched with `meaning: true` in the search options; the index is opened with `{ embedder }` so it
   can embed the question. If the merged API takes the embedder or the option another way, change `meaning.ts` only.
   When combined results equal keyword-only results for every question, the run says the option was most likely
   ignored.

```bash
bun scripts/bench/quality/run.ts --out 2026-11-xx-combined-mac          # both modes, paired comparison
```

### A 2-core estimate

```bash
scripts/bench/quality/docker.sh 2026-11-07-keyword-docker-2cpu --modes keyword
```

Runs `run.ts` in `oven/bun:1.3.12` (the bun of CI and the release bundles) with `--cpus=2 --memory=4g`. The committed
checkout (`git archive HEAD`) and `.cache/wiki` (and `.cache/models`, when present) go in on stdin, because colima does
not mount `/private/tmp`; the results come back on stdout. Commit first. A Lightsail 2-core plan guarantees only about
20% of each core, so this is the best case of such a server, not its average.

## Metrics

- **Recall@8**: an expected file is among the files of the first 8 hits (a hit is a piece; at most 3 per file).
- **First**: the first hit's file is expected. **MRR**: 1 / the rank of the first expected file among the distinct files,
  in hit order (0 when none of the 45 hits is one).
- Per type, per language and overall; the two modes compared on the same questions: Δ with a paired bootstrap 95%
  interval, and the exact McNemar test on the questions only one mode got right.
- A curve over about 50, 500 and all files. Cost: pieces indexed per second, peak memory per phase, query p50 / p95.

## Limits

- Paraphrase and cross questions are built so keyword-only cannot find them (by the plan's definition), so "beats
  keyword-only overall" is close to certain if meaning works at all. The informative part is "not worse on any type":
  exact, table and filename, where fused meaning results can push keyword hits out of the first 8.
- One writer wrote both the documents and the questions; the documents are small and clean; the distractors are
  encyclopedia articles, not office files (the 2026-11-01 test used internal planning files, closer to the targets).
- 30 questions per type: one question is 3.3 points, so per-type differences of one or two questions are noise; read
  the intervals.
- `search` is measured, not the whole lookup: the lookup also drops hits that hold none of the question's words
  (`matchStrength`), which would drop meaning-only hits unless wave 3 changes it.
- Wikipedia changes; `distractors.json` pins the pages, not their revisions (it records the first revision seen).
