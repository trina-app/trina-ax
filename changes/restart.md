- Admin › System › Health has a **Restart…** row for owners and admins: restart the AI only (when answers don't come)
  or the whole app (when the screen freezes), when the running answers finish (at most 10 minutes; it shows how many,
  never whose) or, for the owner, right away. While it waits you can restart now or call it off. It is refused during
  an update, a backup or a prepared restore, and after 5 restarts in an hour; each restart is in the Activity log.
- Office Mac: the supervisor notices a server that stops answering for about 5 minutes. It only logs it for now;
  `TEAMAX_WATCHDOG_KILL=1` in `config/office.env` makes it restart the server (at most 3 times an hour).
