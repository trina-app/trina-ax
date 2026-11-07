# Benchmark: baseline-2026-11-07 on codex

- Date 2026-11-07, source commit 018acc64, 22 made-up documents, 30 questions, one pass.
- Time is the turn's own start to end (turns table); tokens come from the turns table (cache reads and writes included).
- Indexing the documents took 0 s. Correct = the answer finished and contains every expected fact. Target: median time <= 7 s, median input <= 25,000 tokens.

| Group | n | answered | median s | p90 s | median input tok | p90 input tok | median output tok | median tool calls | correct % | expected file cited % |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 30 | 30 | 10.5 | 16.2 | 76,564 | 113,772 | 252 | 2.0 | 100 | 100 |
| find | 5 | 5 | 9.5 | 10.4 | 56,874 | 77,314 | 200 | 1.0 | 100 | 100 |
| answer | 20 | 20 | 10.5 | 13.9 | 76,101 | 95,822 | 252 | 2.0 | 100 | 100 |
| multi | 5 | 5 | 16.2 | 24.6 | 98,161 | 137,988 | 402 | 3.0 | 100 | 100 |
| answer+multi | 25 | 25 | 12.5 | 16.9 | 77,093 | 114,131 | 259 | 2.0 | 100 | 100 |
| korean | 15 | 15 | 10.4 | 20.3 | 75,698 | 114,131 | 261 | 2.0 | 100 | 100 |
| english | 15 | 15 | 10.5 | 16.2 | 77,252 | 98,161 | 231 | 2.0 | 100 | 100 |

## Per question

| id | kind | status | s | input tok | tools | facts | file |
|---|---|---|---|---|---|---|---|
| en-01 | find | done | 5.6 | 38,598 | 1 | ok | ok |
| en-02 | answer | done | 10.5 | 77,252 | 2 | ok | ok |
| en-03 | answer | done | 8.6 | 77,263 | 2 | ok | ok |
| en-04 | answer | done | 13.1 | 95,822 | 3 | ok | ok |
| en-05 | answer | done | 8.9 | 58,283 | 2 | ok | ok |
| en-06 | answer | done | 12.5 | 76,106 | 2 | ok | ok |
| en-07 | answer | done | 12.7 | 76,095 | 2 | ok | ok |
| en-08 | find | done | 9.9 | 77,314 | 2 | ok | ok |
| en-09 | answer | done | 10.5 | 77,021 | 2 | ok | ok |
| en-10 | answer | done | 13.1 | 77,690 | 2 | ok | ok |
| en-11 | answer | done | 6.4 | 38,230 | 1 | ok | ok |
| en-12 | multi | done | 16.2 | 98,161 | 3 | ok | ok |
| en-13 | multi | done | 13.3 | 98,106 | 3 | ok | ok |
| en-14 | answer | done | 10.5 | 77,131 | 2 | ok | ok |
| en-15 | multi | done | 16.9 | 118,121 | 4 | ok | ok |
| ko-01 | find | done | 10.4 | 74,341 | 2 | ok | ok |
| ko-02 | answer | done | 20.3 | 114,131 | 5 | ok | ok |
| ko-03 | answer | done | 13.9 | 75,763 | 2 | ok | ok |
| ko-04 | answer | done | 9.0 | 37,425 | 1 | ok | ok |
| ko-05 | answer | done | 10.2 | 75,818 | 2 | ok | ok |
| ko-06 | answer | done | 15.9 | 113,772 | 4 | ok | ok |
| ko-07 | find | done | 9.4 | 56,010 | 1 | ok | ok |
| ko-08 | answer | done | 10.7 | 75,661 | 2 | ok | ok |
| ko-09 | answer | done | 6.9 | 37,452 | 1 | ok | ok |
| ko-10 | answer | done | 12.8 | 75,698 | 2 | ok | ok |
| ko-11 | answer | done | 9.5 | 77,093 | 2 | ok | ok |
| ko-12 | answer | done | 8.9 | 56,575 | 1 | ok | ok |
| ko-13 | multi | done | 24.6 | 137,988 | 5 | ok | ok |
| ko-14 | multi | done | 13.6 | 95,195 | 3 | ok | ok |
| ko-15 | find | done | 9.5 | 56,874 | 1 | ok | ok |
