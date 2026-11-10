# Benchmark: after-wave-3 on codex

- Date 2026-11-07, source commit 7fd65127, 22 made-up documents, 30 questions, one pass.
- Time is the turn's own start to end (turns table); tokens come from the turns table (cache reads and writes included).
- Indexing the documents took 0 s. Correct = the answer finished and contains every expected fact. Target: median time <= 7 s, median input <= 25,000 tokens.

| Group | n | answered | median s | p90 s | median input tok | p90 input tok | median output tok | median tool calls | correct % | expected file cited % |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 30 | 30 | 8.5 | 12.6 | 59,328 | 78,819 | 193 | 1.0 | 100 | 100 |
| find | 5 | 5 | 9.2 | 17.3 | 59,487 | 117,507 | 162 | 1.0 | 100 | 100 |
| answer | 20 | 20 | 7.6 | 10.1 | 49,834 | 78,569 | 173 | 1.0 | 100 | 100 |
| multi | 5 | 5 | 11.0 | 12.6 | 59,669 | 79,793 | 372 | 1.0 | 100 | 100 |
| answer+multi | 25 | 25 | 8.4 | 11.4 | 59,321 | 78,591 | 198 | 1.0 | 100 | 100 |
| korean | 15 | 15 | 9.9 | 15.0 | 59,487 | 117,024 | 226 | 1.0 | 100 | 100 |
| english | 15 | 15 | 7.5 | 11.0 | 40,287 | 59,967 | 158 | 1.0 | 100 | 100 |

## Per question

| id | kind | status | s | input tok | tools | facts | file |
|---|---|---|---|---|---|---|---|
| en-01 | find | done | 3.8 | 20,810 | 0 | ok | ok |
| en-02 | answer | done | 10.1 | 78,819 | 2 | ok | ok |
| en-03 | answer | done | 7.5 | 59,723 | 1 | ok | ok |
| en-04 | answer | done | 7.6 | 59,967 | 1 | ok | ok |
| en-05 | answer | done | 8.4 | 40,287 | 1 | ok | ok |
| en-06 | answer | done | 3.7 | 21,143 | 0 | ok | ok |
| en-07 | answer | done | 9.9 | 59,380 | 1 | ok | ok |
| en-08 | find | done | 5.5 | 41,038 | 1 | ok | ok |
| en-09 | answer | done | 3.9 | 20,979 | 0 | ok | ok |
| en-10 | answer | done | 9.0 | 40,347 | 1 | ok | ok |
| en-11 | answer | done | 4.6 | 21,059 | 0 | ok | ok |
| en-12 | multi | done | 5.3 | 21,156 | 0 | ok | ok |
| en-13 | multi | done | 11.4 | 59,801 | 1 | ok | ok |
| en-14 | answer | done | 3.7 | 20,840 | 0 | ok | ok |
| en-15 | multi | done | 11.0 | 40,287 | 1 | ok | ok |
| ko-01 | find | done | 17.3 | 117,507 | 4 | ok | ok |
| ko-02 | answer | done | 9.9 | 59,817 | 1 | ok | ok |
| ko-03 | answer | done | 4.6 | 19,316 | 0 | ok | ok |
| ko-04 | answer | done | 10.1 | 59,335 | 1 | ok | ok |
| ko-05 | answer | done | 4.1 | 19,065 | 0 | ok | ok |
| ko-06 | answer | done | 7.5 | 59,380 | 1 | ok | ok |
| ko-07 | find | done | 14.0 | 117,024 | 4 | ok | ok |
| ko-08 | answer | done | 15.0 | 78,591 | 2 | ok | ok |
| ko-09 | answer | done | 5.4 | 40,161 | 1 | ok | ok |
| ko-10 | answer | done | 5.8 | 19,066 | 0 | ok | ok |
| ko-11 | answer | done | 8.5 | 59,321 | 1 | ok | ok |
| ko-12 | answer | done | 10.5 | 78,569 | 2 | ok | ok |
| ko-13 | multi | done | 10.7 | 59,669 | 1 | ok | ok |
| ko-14 | multi | done | 12.6 | 79,793 | 2 | ok | ok |
| ko-15 | find | done | 9.2 | 59,487 | 1 | ok | ok |
