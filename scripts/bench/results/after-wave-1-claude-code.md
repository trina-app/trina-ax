# Benchmark: after-wave-1 on claude-code

- Date 2026-11-07, source commit 2d67ea47, 22 made-up documents, 30 questions, one pass.
- Time is the turn's own start to end (turns table); tokens come from the turns table (cache reads and writes included).
- Indexing the documents took 34.2 s. Correct = the answer finished and contains every expected fact. Target: median time <= 7 s, median input <= 25,000 tokens.

| Group | n | answered | median s | p90 s | median input tok | p90 input tok | median output tok | median tool calls | correct % | expected file cited % |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 30 | 30 | 6.9 | 8.6 | 80,469 | 117,189 | 385 | 1.0 | 100 | 100 |
| find | 5 | 5 | 8.2 | 8.6 | 80,768 | 82,794 | 443 | 1.0 | 100 | 100 |
| answer | 20 | 20 | 6.3 | 7.6 | 77,995 | 83,864 | 325 | 1.0 | 100 | 100 |
| multi | 5 | 5 | 8.5 | 13.6 | 116,924 | 158,721 | 472 | 2.0 | 100 | 100 |
| answer+multi | 25 | 25 | 6.5 | 10.1 | 78,320 | 120,493 | 383 | 1.0 | 100 | 100 |
| korean | 15 | 15 | 7.1 | 8.6 | 78,021 | 120,493 | 388 | 1.0 | 100 | 100 |
| english | 15 | 15 | 6.5 | 10.7 | 82,796 | 117,189 | 383 | 1.0 | 100 | 100 |

## Per question

| id | kind | status | s | input tok | tools | facts | file |
|---|---|---|---|---|---|---|---|
| en-01 | find | done | 7.5 | 82,794 | 0 | ok | ok |
| en-02 | answer | done | 6.5 | 77,995 | 1 | ok | ok |
| en-03 | answer | done | 6.1 | 77,995 | 1 | ok | ok |
| en-04 | answer | done | 6.8 | 77,702 | 1 | ok | ok |
| en-05 | answer | done | 5.0 | 77,582 | 1 | ok | ok |
| en-06 | answer | done | 5.6 | 83,864 | 0 | ok | ok |
| en-07 | answer | done | 8.2 | 117,189 | 2 | ok | ok |
| en-08 | find | done | 8.2 | 80,170 | 1 | ok | ok |
| en-09 | answer | done | 5.2 | 83,320 | 0 | ok | ok |
| en-10 | answer | done | 7.1 | 77,564 | 1 | ok | ok |
| en-11 | answer | done | 6.1 | 83,436 | 0 | ok | ok |
| en-12 | multi | done | 5.6 | 83,794 | 0 | ok | ok |
| en-13 | multi | done | 13.6 | 158,721 | 5 | ok | ok |
| en-14 | answer | done | 5.3 | 82,796 | 0 | ok | ok |
| en-15 | multi | done | 10.7 | 116,924 | 2 | ok | ok |
| ko-01 | find | done | 8.5 | 80,988 | 2 | ok | ok |
| ko-02 | answer | done | 7.5 | 78,021 | 1 | ok | ok |
| ko-03 | answer | done | 7.2 | 78,320 | 0 | ok | ok |
| ko-04 | answer | done | 6.1 | 77,513 | 1 | ok | ok |
| ko-05 | answer | done | 6.2 | 77,586 | 0 | ok | ok |
| ko-06 | answer | done | 6.4 | 77,778 | 1 | ok | ok |
| ko-07 | find | done | 5.8 | 77,322 | 1 | ok | ok |
| ko-08 | answer | done | 7.6 | 77,522 | 1 | ok | ok |
| ko-09 | answer | done | 7.1 | 77,534 | 1 | ok | ok |
| ko-10 | answer | done | 5.1 | 77,550 | 0 | ok | ok |
| ko-11 | answer | done | 10.1 | 124,590 | 2 | ok | ok |
| ko-12 | answer | done | 6.1 | 80,793 | 1 | ok | ok |
| ko-13 | multi | done | 6.9 | 81,102 | 1 | ok | ok |
| ko-14 | multi | done | 8.5 | 120,493 | 2 | ok | ok |
| ko-15 | find | done | 8.6 | 80,768 | 1 | ok | ok |
