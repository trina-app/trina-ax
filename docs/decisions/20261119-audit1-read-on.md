# Long tool results come in parts the AI can read on, not cut

- Date: 2026-11-19
- Status: accepted
- Supersedes: none (adds to "Connection tools" and the web_fetch design, docs/DECISIONS.md)
- Branch: fix/audit1-read-on (limits audit 1 #13, #14, #21)

Owner goal: the AI behaves like Claude Code; a hard cap that must stay pages or keeps the end, and the AI is always told.

- **Connection answers (#13).** Before: an answer over `MAX_RESULT_CHARS` (40,000) was cut with "(cut to 40000
  characters)" and the rest was gone. Now the answer is kept, as the AI was shown it (secrets hidden), for the rest of
  the same answer only (integrations/connections/kept.ts): in memory, per turn and person (one store for every build
  of the turn's tools, so tools rebuilt by connect_service keep the same ids). A store is made only when an answer is
  kept and is removed when its turn ends. Ids are never reused on the server. At most 32 answers and 16 million
  characters per turn (that turn's oldest go first); above 64 million for all running turns a new answer is not kept
  (it is cut as before, and said), and no running turn's answers are dropped for another's. Nothing is written to disk. The first part's line says
  `(characters 0-40000 of N; read on with connection_result {"id": "r1", "offset": 40000})`.
  `connection_result` calls no service. Each call checks again what the original call checked: a running turn of this
  person (`turnChat`), that the person may use the connection (`forCall`), and that the tool the answer came from is not
  turned off or gone from the service's list. In a shared chat it passes the same card as the call that brought the answer (`sharedGate`: the people
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
  16 KiB of each, with a line saying how many bytes were left out; the tool shows that as it is (it cuts again only an
  output the runner did not cut). The runner hides the turn's stored secrets before it cuts (each part is read 4 KiB
  past its cut, hidden, then cut), so a key across a cut is hidden whole, never half shown. Both cuts then go to a line
  break when there is one within 4 KiB. Cuts never
  break a UTF-8 character or an emoji. The tool text tells the AI to send a long output to `$TRINA_LOGS/…` and grep it.
- Kept: all the caps themselves (they bound memory and the model's context). Only how a cut is given changes.
