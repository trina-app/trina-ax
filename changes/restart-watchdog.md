- Self-hosted servers: the supervisor now notices a server that runs but stops answering (no answer for about 5
  minutes after it had answered) and restarts it, at most 3 times an hour; `mycel-ctl status` says when it gave up.
  `"watchdog": {"kill": false}` in `server.json` makes it only write this to the log.
- The AI launcher can be restarted on its own (for Admin › System › Health "AI only"), without restarting the app.
