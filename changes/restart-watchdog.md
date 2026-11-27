- Self-hosted servers: the supervisor now notices a server that runs but stops answering (no answer for about 5
  minutes after it had answered). For now it only writes this to the log; `"watchdog": {"kill": true}` in
  `server.json` makes it restart the server, at most 3 times an hour, and `mycel-ctl status` says when it gave up.
- The AI launcher can be restarted on its own (for Admin › System › Health "AI only"), without restarting the app.
