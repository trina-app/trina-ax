# Long tool results come in parts the AI can read on, not cut

- Date: 2026-11-19
- Status: accepted
- Supersedes: none (adds to "Connection tools" and the web_fetch design, docs/DECISIONS.md)
- Branch: fix/audit1-read-on (limits audit 1 #13, #14, #21)

Owner goal: the AI behaves like Claude Code; a hard cap that must stay pages or keeps the end, and the AI is always told.

- **Connection answers (#13).** Before: an answer over `MAX_RESULT_CHARS` (40,000) was cut with "(cut to 40000
  characters)" and the rest was gone. Now the answer is kept, as the AI was shown it (secrets hidden), for the rest of
  the same answer only: in memory, on the tools of that build (one person, one turn), at most 32 answers and 16 million
  characters (the oldest go first). Nothing is written to disk. The first part's line says
  `(characters 0-40000 of N; read on with connection_result {"id": "r1", "offset": 40000})`.
  `connection_result` calls no service. Each call checks again that the person may use the connection
  (`forCall`). In a shared chat it passes the same card as the call that brought the answer (`sharedGate`: the people
  who see the chat now, a guest and a team connection). The result is wrapped as external data and its secrets are
  hidden again. It is marked read-only, so after a room read it goes on as a connection's read does. A scheduled run
  counts it as a look-up.
  - Offered whenever the turn has a connection tool (also with find_tools / call_tool).
- **Web pages (#14).** `web_fetch` takes `offset`. The first line says which characters came and the next offset, or
  that this is the end. A page over the 5 MB download limit says that only its first 5 MB were read. A part never
  splits an emoji. Fetching the same address again for the next part costs no link budget (the address is already
  learned). The time limit goes from 15 s to 30 s.
- **Command output (#21).** The runner read only the first 64 KiB of stdout and of stderr and the tool showed the
  first 32 KiB of each, so the error at the end of a long build was lost. Now the runner keeps the first and the last
  32 KiB of each, and the tool shows the first and last 16 KiB, with a line saying how much was left out. Cuts never
  break a UTF-8 character or an emoji. The tool text tells the AI to send a long output to `$TRINA_LOGS/…` and grep it.
- Kept: all the caps themselves (they bound memory and the model's context). Only how a cut is given changes.
