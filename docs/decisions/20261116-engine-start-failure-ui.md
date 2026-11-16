# An AI that cannot start says so, tells the admins once, and a stale "Thinking…" ends by itself

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/engine-start-failure-ui (the owner, QA TC-3521)

- **Ask:** the owner, 2026-11-16, in a team project chat with a PDF attached: the answer sat on "Thinking…" for a long
  time, Stop did nothing, and in the end it said "The answer stopped partway. Please try again." Three tries failed the
  same way. The server's automatic update to 0.5.7 had left `app/versions/0.5.7` unreadable to the engine account
  (`drwxr-x---`, files `0640`/`0750`), so every launch failed in under a second with bwrap's
  `Can't find source path …/native/mycel-bridge: Permission denied`. Nothing of the engine ran.
- **Rule 1, the words.** A crash whose stderr is the sandbox's own setup error (`^bwrap: ` or `^sandbox-exec: `, before
  any output) is a new chat error reason, `engine_start_failed` (code `engine_unavailable`): "Trina couldn't start the
  AI on the server, so nothing was done. Your team's admins have been told. Try again once the server is fixed." The
  owner and admins read who fixes it and that trying again won't help (no menu path: the health page does not show
  this). It is not "stopped partway" and it is not retried as a crash: the same launch fails the same way. **Retry with
  another model** is not offered for it (every engine goes through the same sandbox); **Try again** stays.
- **Rule 2, the admins are told once.** The owners and admins get one Inbox notice, `engine.start_failed`, shown always
  (`engine_start_notices`, migration 127, additive, reader 1). One per breakage: no new notice while one was made after
  the last answer that worked; an answer that works arms it again. A member who asked gets no notice; their answer says
  the admins were told.
- **Rule 3, Stop that finds nothing.** `POST /api/chats/:id/stop` answering `stopped: false` while this page still shows
  a running answer means the answer ended on the server and its end never reached the page: the page reads the chat
  again, so it shows how the answer ended. Before, nothing happened and "Thinking…" stayed.
- **Rule 4, a quiet running answer is checked.** A running answer this page heard nothing about for 20 s (no text, no
  step, no end) is read again from the server; while it stays running and quiet the wait doubles, up to 2 minutes. Its
  end over the socket ends the checks. Before, a lost `message.done` left "Thinking…" until a reload.
- **Why the end can be lost:** the potenlab turns ended in 0.4–0.7 s and the server sent `message.done`; the web store
  handles every order of that frame and the send's answer we could build (tests in `chats-store.test.ts`). With the
  frame dropped on the way (a Playwright run that drops it), the page showed exactly what the owner saw: "Thinking…"
  and a Stop answered `{"stopped":false}` with no change. Which link lost it on potenlab was not found from the logs
  read; rules 3 and 4 end the stale state whatever lost it.
- **Left out:** the cause of the unreadable folder (the in-server update unpacks files under the server's
  `UMask=0027`: `server/src/system/tar.ts` creates each file with the archive's mode and never chmods it, and
  `update.ts` stage() leaves the staging folder at `0750`). That fix is separate, and so is having the server repair the
  modes of `app/current` at start, so a 0.5.7 server updating itself does not break again.
- **Tests:** `tests/unit/b-engine-start-failed.test.ts` (the words, one launch, one notice per breakage, a plain crash
  still retried), `web/test/unit/chats-quiet-answer.test.ts` (Stop that finds nothing, the quiet check and its backoff),
  `web/test/unit/chat-error-words.test.ts`, `web/test/unit/hosting-notices.test.tsx`. The fake engine has
  `@fake {"startFail": true}`.
- **Version impact:** migration 127 (new table, reader 1). An older web on a newer server shows the server's words.
