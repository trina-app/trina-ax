- When many answers can start at the same moment (a raised "answers at the same time" setting), they now start three
  at a time, the next three 0.2 s later, in the same order. On a small server, 15 answers starting together no longer
  freeze the app for up to a second and a half.
- Searching team files by name on a very large folder no longer pauses the app for everyone while it runs. A broad
  search now looks at up to 1,000 matching files (was 5,000), shows the newest of them and says there are more.
- Answers held back that moment do not count as "waiting": one person can still send as many questions as there are
  free answer slots, and scheduled tasks due together are not put off. The "queued" line under an answer shows only
  when it really waits (after 0.4 s), so a burst no longer flashes it.
