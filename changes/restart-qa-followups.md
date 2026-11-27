- **Restart…** (Admin › System › Health): a restart that was called off no longer counts towards the limit (2 minutes
  apart, 5 an hour), so the row no longer says "It was just restarted" when nothing restarted. Only restarts that ran
  count. The dialog says it waits for running answers only when some run, and right after "AI only" the row shows that
  restart instead of the one before.
- A chat whose answer a restart or an update cut off says **Interrupted by a restart** (or **by an update**) in the
  chat list, search and notifications, as the chat itself does, instead of "Stopped: an error".
