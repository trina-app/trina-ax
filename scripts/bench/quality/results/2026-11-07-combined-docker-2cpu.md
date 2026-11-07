# Search quality test: 2026-11-07-combined-docker-2cpu

- Date: 2026-11-07T14:22:45.526Z; label: 2 CPUs 4 GB; vectors from the Mac run; model downloaded in the container; embedding pace on 400 pieces at the server's settings; commit c51e4066
- Machine: unknown, 2 cores, 7.7 GB, linux/arm64, bun 1.3.12; cgroup cpu.max 200000 100000, memory.max 4294967296
- Corpus: 49 made-up Acme documents + 3000 Wikipedia articles (ko 1500, en 1500); 22096 pieces; 0 distractors not indexed
- Questions: 150 (paraphrase 30, exact 30, table 30, cross 30, filename 30); words: the AI's lookup (questionTerms); 45 hits asked, Recall and first place over the first 8 hits
- Modes run: keyword, combined

## Results on the full set

| Group | keyword: Recall@8 | first | MRR | combined: Recall@8 | first | MRR |
|---|---|---|---|---|---|---|
| overall | 47.3% (71/150) | 38.7% (58/150) | 0.419 | 51.3% (77/150) | 42% (63/150) | 0.463 |
| paraphrase | 0% (0/30) | 0% (0/30) | 0.000 | 3.3% (1/30) | 0% (0/30) | 0.014 |
| exact | 83.3% (25/30) | 73.3% (22/30) | 0.766 | 86.7% (26/30) | 73.3% (22/30) | 0.776 |
| table | 90% (27/30) | 73.3% (22/30) | 0.802 | 93.3% (28/30) | 73.3% (22/30) | 0.818 |
| cross | 0% (0/30) | 0% (0/30) | 0.000 | 0% (0/30) | 0% (0/30) | 0.004 |
| filename | 63.3% (19/30) | 46.7% (14/30) | 0.528 | 73.3% (22/30) | 63.3% (19/30) | 0.704 |
| ko | 46.7% (35/75) | 36% (27/75) | 0.399 | 50.7% (38/75) | 42.7% (32/75) | 0.461 |
| en | 48% (36/75) | 41.3% (31/75) | 0.439 | 52% (39/75) | 41.3% (31/75) | 0.465 |

## Combined minus keyword-only, same questions (full set)

Δ is the change in share of questions; [95% paired bootstrap interval]; McNemar: questions only keyword / only combined got right, exact two-sided p.

| Group | Δ Recall@8 | McNemar R@8 | Δ first | McNemar first | Δ MRR |
|---|---|---|---|---|---|
| overall | +4% [0.7%, 8%] | 1/7, p=0.0703 | +3.3% [-1.3%, 8%] | 4/9, p=0.2668 | +0.044 [0.009, 0.081] |
| paraphrase | +3.3% [0%, 10%] | 0/1, p=1 | +0% [0%, 0%] | 0/0, p=1 | +0.014 [0.003, 0.028] |
| exact | +3.3% [0%, 10%] | 0/1, p=1 | +0% [-13.3%, 13.3%] | 2/2, p=1 | +0.010 [-0.094, 0.113] |
| table | +3.3% [-6.7%, 13.3%] | 1/2, p=1 | +0% [-13.3%, 13.3%] | 2/2, p=1 | +0.016 [-0.086, 0.107] |
| cross | +0% [0%, 0%] | 0/0, p=1 | +0% [0%, 0%] | 0/0, p=1 | +0.004 [0.000, 0.013] |
| filename | +10% [0%, 23.3%] | 0/3, p=0.25 | +16.7% [3.3%, 30%] | 0/5, p=0.0625 | +0.176 [0.086, 0.280] |
| ko | +4% [0%, 9.3%] | 0/3, p=0.25 | +6.7% [0%, 14.7%] | 1/6, p=0.125 | +0.062 [0.018, 0.110] |
| en | +4% [-1.3%, 9.3%] | 1/4, p=0.375 | +0% [-6.7%, 6.7%] | 3/3, p=1 | +0.026 [-0.028, 0.081] |

## Curve: Recall@8 / first / MRR by number of files

| Files | Pieces | keyword | combined | keyword R@8 by type (para / exac / tabl / cros / file) | combined R@8 by type (para / exac / tabl / cros / file) |
|---|---|---|---|---|---|
| full (3049) | 22096 | 47.3% / 38.7% / 0.419 | 51.3% / 42% / 0.463 | 0% / 83.3% / 90% / 0% / 63.3% | 3.3% / 86.7% / 93.3% / 0% / 73.3% |

## Cost

- Index reused from an earlier run (--reuse-index): 3049 files, 22096 pieces with their vectors; documents.db 188 MB
- Embedding pace on a sample (the same loop and process, 1 ONNX thread(s), batches of 4, background priority): 400 pieces in 147 s = 2.7 pieces/s; embedding process peak 746 MiB; model downloaded in 4.4 s
- Combined search: 1950 hits found by meaning only across the 150 questions on the full set; worker open to the first combined answer (vectors and the query's model loaded) 5.5 s
- Peak RSS by phase (MB, sampled every 100 ms and after every file and question): setup 178, index 182, model 529, embed-sample 529, embed 499, prepare 499, query-keyword 1264, query-combined 1299, report 1295; process max 1299 MB
- Query time (ms, one search through the search worker, round trip included; combined includes the question's embedding): full (3049): keyword p50 26.25 / p95 76.38, combined p50 35.48 / p95 87.53

## Misses on the full set (ids)

- keyword, not in the first 8 (79): paraphrase: p-en-01, p-en-02, p-en-03, p-en-04, p-en-05, p-en-06, p-en-07, p-en-08, p-en-09, p-en-10, p-en-11, p-en-12, p-en-13, p-en-14, p-en-15, p-ko-01, p-ko-02, p-ko-03, p-ko-04, p-ko-05, p-ko-06, p-ko-07, p-ko-08, p-ko-09, p-ko-10, p-ko-11, p-ko-12, p-ko-13, p-ko-14, p-ko-15; exact: x-ko-01, x-ko-06, x-ko-09, x-ko-10, x-ko-13; table: t-en-09, t-ko-06, t-ko-11; cross: c-ko-01, c-ko-02, c-ko-03, c-ko-04, c-ko-05, c-ko-06, c-ko-07, c-ko-08, c-ko-09, c-ko-10, c-ko-11, c-ko-12, c-ko-13, c-ko-14, c-ko-15, c-en-01, c-en-02, c-en-03, c-en-04, c-en-05, c-en-06, c-en-07, c-en-08, c-en-09, c-en-10, c-en-11, c-en-12, c-en-13, c-en-14, c-en-15; filename: f-en-01, f-en-02, f-en-03, f-en-05, f-en-06, f-en-09, f-en-13, f-en-14, f-ko-01, f-ko-02, f-ko-04
- combined, not in the first 8 (73): paraphrase: p-en-01, p-en-02, p-en-04, p-en-05, p-en-06, p-en-07, p-en-08, p-en-09, p-en-10, p-en-11, p-en-12, p-en-13, p-en-14, p-en-15, p-ko-01, p-ko-02, p-ko-03, p-ko-04, p-ko-05, p-ko-06, p-ko-07, p-ko-08, p-ko-09, p-ko-10, p-ko-11, p-ko-12, p-ko-13, p-ko-14, p-ko-15; exact: x-ko-06, x-ko-09, x-ko-10, x-ko-13; table: t-en-03, t-ko-11; cross: c-ko-01, c-ko-02, c-ko-03, c-ko-04, c-ko-05, c-ko-06, c-ko-07, c-ko-08, c-ko-09, c-ko-10, c-ko-11, c-ko-12, c-ko-13, c-ko-14, c-ko-15, c-en-01, c-en-02, c-en-03, c-en-04, c-en-05, c-en-06, c-en-07, c-en-08, c-en-09, c-en-10, c-en-11, c-en-12, c-en-13, c-en-14, c-en-15; filename: f-en-01, f-en-03, f-en-05, f-en-06, f-en-09, f-en-13, f-ko-01, f-ko-02
