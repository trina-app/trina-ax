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
bun scripts/bench/quality/fetch.ts                 # once: 22 minutes on 2026-11-07 (about 3,800 requests, 46 MB)
bun scripts/bench/quality/run.ts --modes keyword --out 2026-11-07-keyword-mac
```

`run.ts` builds a temporary index with the server's own `DocumentIndex` and extraction (`files/extract.ts`, CP949 like
grep), every file in a fixed shuffled order (sha256 of its path): the full-text index takes the first few hundred matches
of a word unranked, by row order, so targets must not all come first. It then copies the index for the smaller sizes
(about 50 and 500 files: the 49 targets plus the first distractors in the same order) and takes the other files out
again. Every question goes through the real search worker (`DocSearchWorker`, `documents/search-worker.ts`) the way the
AI's lookup sends it (`service.ts` docPassages: the question's distinctive words, `questionTerms`, joined, which is also
the text the question is embedded from; limit 45; passages of 1,500 characters). `--words search` sends every word
instead, as the Files search box does.

Options: `--modes keyword,combined` (default both; combined is skipped with the reason when it cannot run),
`--sizes 50,500,full`, `--max-distractors <n>`, `--out <name>`, `--label <text>`, `--keep <dir>` (keep the indexes),
`--bootstrap <n>` (default 10,000).

### Combined mode (`meaning.ts`)

Each index is laid out like a server's data folder: `<tmp>/<size>/knowledge-graph/documents`, and `<tmp>/<size>/models`
linked to the model folder, where the search worker looks for the model (`meaningModelDirs`, no download there).

1. The model: `ensureModel()` into `--model-dir` (default `scripts/bench/quality/.cache/models`, 129 MB), checked against
   the pinned hashes; `--no-download` refuses to fetch it.
2. The vectors: the server's own background loop, `MeaningIndexer` (`meaning/indexer.ts`: `pendingVectors`,
   `passageText`, `writeVectors`), with the embedding process `embed-worker.ts`. Only the pace differs:
   `--embed-threads` (default min(6, cores)), `--embed-batch` (default 16), `--embed-max-rss` (default 4000 MiB, the
   loop's limit for the process), and `--embed-priority normal` (default) starts the same script without the
   below-people's-work prefix. The server uses 1 thread, batches of 4 and background priority, which on an M-series Mac
   keeps it to the efficiency cores (3.4 pieces/s with 6 threads): slower by design. `--embed-priority background`
   reproduces it.
3. The search: `meaning: true` in the worker, which embeds the question in its own thread and fuses by rank; a deadline
   of `--due-ms` (default 120 s), because the deadline is about chat latency, not quality. Three searches warm the
   worker first. Hits found only by meaning (`byMeaning`) are counted; when there are none, or combined equals
   keyword-only for every question, the run says the meaning part did not run.
4. `--reuse-index <dir>` takes an earlier run's full index with its vectors (`--keep <k>` leaves it in
   `<k>/full/knowledge-graph/documents`), so a small machine can be timed on the full set without hours of embedding;
   `--embed-sample <n>` then measures that machine's embedding pace on n pieces of a copy, through the same loop.

```bash
bun scripts/bench/quality/run.ts --out 2026-11-07-combined-mac --keep <scratch>/kg-keep
```

### A 2-core estimate

```bash
scripts/bench/quality/docker.sh 2026-11-07-keyword-docker-2cpu --modes keyword
QUALITY_REUSE=<scratch>/kg-keep/full/knowledge-graph/documents scripts/bench/quality/docker.sh \
  2026-11-07-combined-docker-2cpu --reuse-index quality-reuse --embed-sample 400 --embed-threads 1 --embed-batch 4 \
  --embed-priority background --sizes full
```

Runs `run.ts` in `oven/bun:1.3.12` (the bun of CI and the release bundles) with `--cpus=2 --memory=4g`. The committed
checkout (`git archive HEAD`) and `.cache/wiki` go in on stdin, because colima does not mount `/private/tmp`; the
results come back on stdout. The model is downloaded inside the container (`QUALITY_MODELS=1` pipes `.cache/models` in
instead); `QUALITY_REUSE` pipes in an index with its vectors. Commit first. A Lightsail 2-core plan guarantees only
about 20% of each core, so this is the best case of such a server, not its average.

## Results so far

| Run | Recall@8 | First | MRR | exact / table / filename R@8 | Index | Query p50 / p95 |
|---|---|---|---|---|---|---|
| [keyword, this Mac](results/2026-11-07-keyword-mac.md) | 47.3% | 38.7% | 0.419 | 83% / 90% / 63% | 547 pieces/s | 15.6 / 32.8 ms |
| [keyword, Docker 2 CPUs 4 GB](results/2026-11-07-keyword-docker-2cpu.md) | 47.3% | 38.7% | 0.419 | 83% / 90% / 63% | 465 pieces/s | 14.6 / 30.4 ms |
| [combined, this Mac](results/2026-11-07-combined-mac.md) (keyword in the same run: as above) | 51.3% | 42.0% | 0.463 | 87% / 93% / 73% | 8.1 pieces/s embedded (6 threads) | 32.5 / 82.9 ms (keyword 20.3 / 64.1, worker) |
| [combined, Docker 2 CPUs 4 GB](results/2026-11-07-combined-docker-2cpu.md) (the Mac's vectors) | 51.3% | 42.0% | 0.463 | 87% / 93% / 73% | 2.7 pieces/s embedded (server settings: 1 thread, batches of 4) | 35.5 / 87.5 ms (keyword 26.3 / 76.4, worker) |

Paraphrase and cross are 0% for keyword-only, as built; combined reaches 3.3% and 0% on the full set (70% and 13% at 50
files). The model alone (no fusion) puts the expected file in its top 8 for paraphrase 4/30, cross 1/30, filename
29/30, table 27/30 and exact 20/30, with the question embedded from its words joined or as typed alike: the fusion
with keyword hits takes filename from 29 to 22.

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
- The worker's `search` is measured, not the whole lookup: the lookup keeps meaning-only hits as weak (never pasted as
  strong passages), drops keyword hits that hold none of the words as words, and checks each file for the person.
- The question is embedded from its distinctive words joined (what the lookup sends), not from the sentence as typed.
- Wikipedia changes; `distractors.json` pins the pages, not their revisions (it records the first revision seen).
