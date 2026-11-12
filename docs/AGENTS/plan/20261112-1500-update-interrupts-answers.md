# Answers an update cuts off end cleanly and say so (QA TC-338)

QA TC-338 (Fail): after `sudo mycel-ctl update` (0.4.0 → 0.5.0) the answers still running read "The AI engine stopped
unexpectedly" (internal, reason crash), and the server logged "turn slot quarantined: termination unconfirmed" for each
of them until the app switch restarted it. Cause: `systemctl restart <id>-launcher` killed the launcher and its engines
at once; the server read only a broken socket (SocketLauncher's `launcher: …` error), which proves nothing about the
engine, so the turn failed as a crash and its slot stayed quarantined (#442/#493 rules, kept for real breaks).

## Plan
- `native/cmd/mycel-launcher/ending.go`: an orderly stop. SIGTERM / SIGINT end every live turn (as a kill does) and
  each reports `{"ev":"exit",…,"signal":"shutdown"}` before the launcher exits; new turns are refused with the same
  exit. `{"op":"prepare-stop","reason":"update"}` (server uid only) ends the live turns now with `"signal":"update"`
  and answers once their exits are sent; a stop in the next two minutes says "update" too. A turn that ended on its
  own keeps its exit.
- `native/cmd/mycel-ctl/update.go`: before `systemctl restart <id>-launcher`, prepare-stop "update" (as the server
  account, like the status request); an administrator's wait prints how many running answers it waits for (stderr).
- `server/src/chat/turn.ts`: an exit with signal "update" / "shutdown" is a confirmed end: the turn stops as
  interrupted (no crash retry, no quarantine) and the answer says `updating` or `interrupted`.
- `server/src/chat/runtime.ts` shutdown: the cause (`system/update-underway.ts`: app/current points at another
  version, or the office updater runs) picks `updating`; a settings note lets the next start's recovery say the same
  for an answer that did not end in time. Queue and schedules: unchanged, tested.
- `shared/src/api/errors.ts` + web i18n (5 locales): the `updating` chat error.
- Review round 1: per-turn end channels instead of a shared WaitGroup (reuse panic); a prepare-stop also refuses new
  turns (`launcher_stopping: <reason>`, before anything starts) and the status says `stopping`; the server holds its
  queue after a launcher stop until a launcher answers that is not stopping (an update's hold lasts 2 minutes at
  least: the server restarts next and the queue runs on the new version), and a refused launch waits and is made
  again; the signal stop fits in TimeoutStopSec (6 s, then SIGKILL); a second signal exits at once.
- Tests: unit tests with the fake engine (launcher stop, server stop, restart with queue and schedule, recovery), the
  real launcher binary (prepare-stop, SIGTERM, normal end), Go test for the ctl order and wait message.
