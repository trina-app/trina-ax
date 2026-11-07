# Search quality test: 2026-11-07-keyword-docker-2cpu

- Date: 2026-11-07T13:14:23.506Z; label: keyword-only in Docker, --cpus=2 --memory=4g; commit 7edad2a6
- Machine: unknown, 2 cores, 7.7 GB, linux/arm64, bun 1.3.12; cgroup cpu.max 200000 100000, memory.max 4294967296
- Corpus: 49 made-up Acme documents + 3000 Wikipedia articles (ko 1500, en 1500); 22096 pieces; 0 distractors not indexed
- Questions: 150 (paraphrase 30, exact 30, table 30, cross 30, filename 30); words: the AI's lookup (questionTerms); 45 hits asked, Recall and first place over the first 8 hits
- Modes run: keyword

## Results on the full set

| Group | keyword: Recall@8 | first | MRR |
|---|---|---|---|
| overall | 47.3% (71/150) | 38.7% (58/150) | 0.419 |
| paraphrase | 0% (0/30) | 0% (0/30) | 0.000 |
| exact | 83.3% (25/30) | 73.3% (22/30) | 0.766 |
| table | 90% (27/30) | 73.3% (22/30) | 0.802 |
| cross | 0% (0/30) | 0% (0/30) | 0.000 |
| filename | 63.3% (19/30) | 46.7% (14/30) | 0.528 |
| ko | 46.7% (35/75) | 36% (27/75) | 0.399 |
| en | 48% (36/75) | 41.3% (31/75) | 0.439 |

## Curve: Recall@8 / first / MRR by number of files

| Files | Pieces | keyword | keyword R@8 by type (para / exac / tabl / cros / file) |
|---|---|---|---|
| 50 | 54 | 59.3% / 50% / 0.534 | 0% / 100% / 100% / 6.7% / 90% |
| 500 | 3308 | 52.7% / 44% / 0.476 | 0% / 90% / 96.7% / 0% / 76.7% |
| full (3049) | 22096 | 47.3% / 38.7% / 0.419 | 0% / 83.3% / 90% / 0% / 63.3% |

## Cost

- Indexing (keyword, one thread, text extraction included): 3049 files, 22096 pieces in 47.6 s = 465 pieces/s; documents.db 181 MB
- Peak RSS by phase (MB, sampled every 100 ms and after every file and question): setup 177, index 226, prepare 254, query-keyword 277, report 276; process max 277 MB
- Query time (ms, one search, the server's own thread): 50: keyword p50 4 / p95 11.81; 500: keyword p50 8.2 / p95 25.72; full (3049): keyword p50 14.56 / p95 30.36

## Misses on the full set (ids)

- keyword, not in the first 8 (79): paraphrase: p-en-01, p-en-02, p-en-03, p-en-04, p-en-05, p-en-06, p-en-07, p-en-08, p-en-09, p-en-10, p-en-11, p-en-12, p-en-13, p-en-14, p-en-15, p-ko-01, p-ko-02, p-ko-03, p-ko-04, p-ko-05, p-ko-06, p-ko-07, p-ko-08, p-ko-09, p-ko-10, p-ko-11, p-ko-12, p-ko-13, p-ko-14, p-ko-15; exact: x-ko-01, x-ko-06, x-ko-09, x-ko-10, x-ko-13; table: t-en-09, t-ko-06, t-ko-11; cross: c-ko-01, c-ko-02, c-ko-03, c-ko-04, c-ko-05, c-ko-06, c-ko-07, c-ko-08, c-ko-09, c-ko-10, c-ko-11, c-ko-12, c-ko-13, c-ko-14, c-ko-15, c-en-01, c-en-02, c-en-03, c-en-04, c-en-05, c-en-06, c-en-07, c-en-08, c-en-09, c-en-10, c-en-11, c-en-12, c-en-13, c-en-14, c-en-15; filename: f-en-01, f-en-02, f-en-03, f-en-05, f-en-06, f-en-09, f-en-13, f-en-14, f-ko-01, f-ko-02, f-ko-04
