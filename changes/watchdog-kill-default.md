- Self-hosted servers: the supervisor now restarts a server that runs but stops answering (no answer for about 5
  minutes after it had answered), at most 3 times an hour; `mycel-ctl status` says when it gave up. In 0.20.1 it only
  wrote this to the log. `"watchdog": {"kill": false}` in `server.json` keeps the old log-only behaviour.
- Office Mac: the supervisor now restarts a server that stops answering for about 5 minutes (at most 3 times an hour).
  `TEAMAX_WATCHDOG_KILL=0` in `config/office.env` makes it only log it.
- Restoring a database backup no longer freezes the app while the backup is checked (the check of a big database
  took minutes); it runs in the background.
- Moving a big folder, or changing the access rules at the top of a big team folder, no longer stops the app for
  minutes while the file list follows the change.
