# Benchmark: after-wave-1 on codex

- Date 2026-11-07, source commit 2d67ea47, 22 made-up documents, 30 questions, one pass.
- Time is the turn's own start to end (turns table); tokens come from the turns table (cache reads and writes included).
- Indexing the documents took 0 s. Correct = the answer finished and contains every expected fact. Target: median time <= 7 s, median input <= 25,000 tokens.

| Group | n | answered | median s | p90 s | median input tok | p90 input tok | median output tok | median tool calls | correct % | expected file cited % |
|---|---|---|---|---|---|---|---|---|---|---|
| all | 30 | 30 | 7.9 | 14.4 | 57,949 | 102,868 | 204 | 1.0 | 97 | 97 |
| find | 5 | 5 | 7.8 | 15.3 | 58,692 | 102,868 | 157 | 1.0 | 80 | 80 |
| answer | 20 | 20 | 7.5 | 9.9 | 57,949 | 59,163 | 204 | 1.0 | 100 | 100 |
| multi | 5 | 5 | 9.3 | 16.6 | 41,931 | 116,156 | 330 | 1.0 | 100 | 100 |
| answer+multi | 25 | 25 | 8.0 | 14.4 | 57,909 | 114,386 | 205 | 1.0 | 100 | 100 |
| korean | 15 | 15 | 8.1 | 9.9 | 58,077 | 58,824 | 209 | 1.0 | 100 | 100 |
| english | 15 | 15 | 7.3 | 15.3 | 40,001 | 114,386 | 197 | 1.0 | 93 | 93 |

## Per question

| id | kind | status | s | input tok | tools | facts | file |
|---|---|---|---|---|---|---|---|
| en-01 | find | done | 3.9 | 20,560 | 0 | ok | ok |
| en-02 | answer | done | 9.5 | 58,063 | 1 | ok | ok |
| en-03 | answer | done | 7.3 | 58,624 | 1 | ok | ok |
| en-04 | answer | done | 14.4 | 114,386 | 5 | ok | ok |
| en-05 | answer | done | 7.8 | 40,001 | 1 | ok | ok |
| en-06 | answer | done | 3.9 | 20,889 | 0 | ok | ok |
| en-07 | answer | done | 7.0 | 59,163 | 1 | ok | ok |
| en-08 | find | done | 15.3 | 102,868 | 4 | missing incident-report-2026-09 | no |
| en-09 | answer | done | 3.8 | 20,721 | 0 | ok | ok |
| en-10 | answer | done | 7.1 | 39,583 | 1 | ok | ok |
| en-11 | answer | done | 4.3 | 20,811 | 0 | ok | ok |
| en-12 | multi | done | 8.2 | 41,931 | 0 | ok | ok |
| en-13 | multi | done | 16.6 | 116,156 | 4 | ok | ok |
| en-14 | answer | done | 5.9 | 20,586 | 0 | ok | ok |
| en-15 | multi | done | 9.3 | 39,290 | 1 | ok | ok |
| ko-01 | find | done | 8.7 | 58,692 | 1 | ok | ok |
| ko-02 | answer | done | 9.4 | 58,077 | 1 | ok | ok |
| ko-03 | answer | done | 4.5 | 19,056 | 0 | ok | ok |
| ko-04 | answer | done | 7.9 | 57,909 | 1 | ok | ok |
| ko-05 | answer | done | 3.5 | 18,815 | 0 | ok | ok |
| ko-06 | answer | done | 8.1 | 58,645 | 1 | ok | ok |
| ko-07 | find | done | 7.1 | 39,686 | 1 | ok | ok |
| ko-08 | answer | done | 9.4 | 57,988 | 1 | ok | ok |
| ko-09 | answer | done | 15.2 | 115,775 | 4 | ok | ok |
| ko-10 | answer | done | 3.6 | 18,812 | 0 | ok | ok |
| ko-11 | answer | done | 8.0 | 58,313 | 1 | ok | ok |
| ko-12 | answer | done | 9.9 | 58,416 | 1 | ok | ok |
| ko-13 | multi | done | 8.9 | 39,897 | 1 | ok | ok |
| ko-14 | multi | done | 9.9 | 58,264 | 1 | ok | ok |
| ko-15 | find | done | 7.8 | 58,824 | 1 | ok | ok |
