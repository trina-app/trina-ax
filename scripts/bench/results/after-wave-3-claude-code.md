# Benchmark: after-wave-3 on claude-code

- Date 2026-11-07, source commit 7fd65127, 22 made-up documents, 30 questions, one pass.
- Time is the turn's own start to end (turns table); tokens come from the turns table (cache reads and writes included).
- Indexing the documents took 0 s. Correct = the answer finished and contains every expected fact. Target: median time <= 7 s, median input <= 25,000 tokens.

| Group | n | answered | median s | p90 s | median input tok | p90 input tok | median output tok | median tool calls | correct % | expected file cited % |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 30 | 30 | 8.6 | 12.1 | 81,572 | 124,217 | 403 | 1.0 | 100 | 100 |
| find | 5 | 5 | 9.3 | 12.9 | 81,599 | 83,426 | 424 | 1.0 | 100 | 100 |
| answer | 20 | 20 | 8.2 | 10.2 | 78,801 | 84,494 | 328 | 1.0 | 100 | 100 |
| multi | 5 | 5 | 10.3 | 14.8 | 121,564 | 160,383 | 599 | 2.0 | 100 | 100 |
| answer+multi | 25 | 25 | 8.4 | 12.1 | 81,544 | 124,346 | 366 | 1.0 | 100 | 100 |
| korean | 15 | 15 | 8.9 | 10.6 | 81,510 | 124,217 | 447 | 1.0 | 100 | 100 |
| english | 15 | 15 | 8.2 | 14.7 | 83,426 | 157,964 | 294 | 1.0 | 100 | 100 |

## Per question

| id | kind | status | s | input tok | tools | facts | file |
|---|---|---|---|---|---|---|---|
| en-01 | find | done | 8.7 | 83,426 | 0 | ok | ok |
| en-02 | answer | done | 10.2 | 78,625 | 1 | ok | ok |
| en-03 | answer | done | 7.1 | 78,639 | 1 | ok | ok |
| en-04 | answer | done | 8.5 | 78,330 | 1 | ok | ok |
| en-05 | answer | done | 8.2 | 78,196 | 1 | ok | ok |
| en-06 | answer | done | 6.5 | 84,494 | 0 | ok | ok |
| en-07 | answer | done | 7.0 | 81,544 | 1 | ok | ok |
| en-08 | find | done | 12.9 | 82,369 | 1 | ok | ok |
| en-09 | answer | done | 6.3 | 83,952 | 0 | ok | ok |
| en-10 | answer | done | 9.4 | 78,196 | 1 | ok | ok |
| en-11 | answer | done | 7.3 | 84,062 | 0 | ok | ok |
| en-12 | multi | done | 6.7 | 84,424 | 0 | ok | ok |
| en-13 | multi | done | 14.7 | 160,383 | 6 | ok | ok |
| en-14 | answer | done | 6.7 | 83,438 | 0 | ok | ok |
| en-15 | multi | done | 14.8 | 157,964 | 3 | ok | ok |
| ko-01 | find | done | 9.9 | 81,599 | 2 | ok | ok |
| ko-02 | answer | done | 8.9 | 78,651 | 1 | ok | ok |
| ko-03 | answer | done | 8.7 | 78,950 | 0 | ok | ok |
| ko-04 | answer | done | 8.4 | 78,147 | 1 | ok | ok |
| ko-05 | answer | done | 8.3 | 78,218 | 0 | ok | ok |
| ko-06 | answer | done | 10.6 | 124,346 | 2 | ok | ok |
| ko-07 | find | done | 8.9 | 78,017 | 1 | ok | ok |
| ko-08 | answer | done | 8.4 | 78,154 | 1 | ok | ok |
| ko-09 | answer | done | 7.7 | 81,668 | 1 | ok | ok |
| ko-10 | answer | done | 6.9 | 78,176 | 0 | ok | ok |
| ko-11 | answer | done | 12.1 | 124,217 | 2 | ok | ok |
| ko-12 | answer | done | 7.6 | 81,533 | 1 | ok | ok |
| ko-13 | multi | done | 10.2 | 81,654 | 1 | ok | ok |
| ko-14 | multi | done | 10.3 | 121,564 | 2 | ok | ok |
| ko-15 | find | done | 9.3 | 81,510 | 1 | ok | ok |
