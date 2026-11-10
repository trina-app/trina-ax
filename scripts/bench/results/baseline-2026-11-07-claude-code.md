# Benchmark: baseline-2026-11-07 on claude-code

- Date 2026-11-07, source commit 018acc64, 22 made-up documents, 30 questions, one pass.
- Time is the turn's own start to end (turns table); tokens come from the turns table (cache reads and writes included).
- Indexing the documents took 0 s. Correct = the answer finished and contains every expected fact. Target: median time <= 7 s, median input <= 25,000 tokens.

| Group | n | answered | median s | p90 s | median input tok | p90 input tok | median output tok | median tool calls | correct % | expected file cited % |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 30 | 30 | 7.4 | 10.0 | 116,964 | 119,877 | 461 | 2.0 | 100 | 100 |
| find | 5 | 5 | 7.2 | 8.3 | 77,889 | 119,377 | 500 | 2.0 | 100 | 100 |
| answer | 20 | 20 | 7.0 | 9.9 | 117,034 | 119,782 | 410 | 2.0 | 100 | 100 |
| multi | 5 | 5 | 8.0 | 12.3 | 117,383 | 161,637 | 607 | 3.0 | 100 | 100 |
| answer+multi | 25 | 25 | 7.4 | 11.9 | 117,383 | 119,887 | 430 | 2.0 | 100 | 100 |
| korean | 15 | 15 | 8.0 | 11.9 | 78,156 | 119,877 | 465 | 2.0 | 100 | 100 |
| english | 15 | 15 | 6.9 | 8.6 | 119,030 | 119,887 | 414 | 2.0 | 100 | 100 |

## Per question

| id | kind | status | s | input tok | tools | facts | file |
|---|---|---|---|---|---|---|---|
| en-01 | find | done | 8.0 | 119,377 | 3 | ok | ok |
| en-02 | answer | done | 7.4 | 119,782 | 2 | ok | ok |
| en-03 | answer | done | 6.4 | 119,887 | 2 | ok | ok |
| en-04 | answer | done | 7.2 | 119,248 | 2 | ok | ok |
| en-05 | answer | done | 5.7 | 79,129 | 2 | ok | ok |
| en-06 | answer | done | 6.8 | 119,030 | 2 | ok | ok |
| en-07 | answer | done | 6.6 | 119,327 | 2 | ok | ok |
| en-08 | find | done | 6.9 | 118,619 | 2 | ok | ok |
| en-09 | answer | done | 6.7 | 119,763 | 2 | ok | ok |
| en-10 | answer | done | 8.6 | 78,738 | 1 | ok | ok |
| en-11 | answer | done | 5.2 | 78,520 | 1 | ok | ok |
| en-12 | multi | done | 7.9 | 117,383 | 3 | ok | ok |
| en-13 | multi | done | 7.3 | 80,647 | 2 | ok | ok |
| en-14 | answer | done | 5.5 | 78,804 | 1 | ok | ok |
| en-15 | multi | done | 12.3 | 161,637 | 5 | ok | ok |
| ko-01 | find | done | 6.4 | 77,632 | 2 | ok | ok |
| ko-02 | answer | done | 10.0 | 119,877 | 2 | ok | ok |
| ko-03 | answer | done | 13.3 | 117,524 | 2 | ok | ok |
| ko-04 | answer | done | 8.4 | 117,905 | 2 | ok | ok |
| ko-05 | answer | done | 7.7 | 116,544 | 2 | ok | ok |
| ko-06 | answer | done | 8.2 | 118,739 | 2 | ok | ok |
| ko-07 | find | done | 7.2 | 77,415 | 2 | ok | ok |
| ko-08 | answer | done | 7.7 | 77,553 | 1 | ok | ok |
| ko-09 | answer | done | 5.8 | 77,427 | 1 | ok | ok |
| ko-10 | answer | done | 6.6 | 77,247 | 1 | ok | ok |
| ko-11 | answer | done | 9.9 | 77,744 | 1 | ok | ok |
| ko-12 | answer | done | 5.9 | 78,156 | 1 | ok | ok |
| ko-13 | multi | done | 11.9 | 159,419 | 4 | ok | ok |
| ko-14 | multi | done | 8.0 | 78,336 | 2 | ok | ok |
| ko-15 | find | done | 8.3 | 77,889 | 1 | ok | ok |
