- An answer that an update cuts off now says "This answer stopped because Trina was updating. Send it again." instead of
  "The AI engine stopped unexpectedly". Its chat is free again at once (before, the turn slot was held for a while
  after `mycel-ctl update` restarted the engine launcher). Messages waiting in the queue, and new ones sent during the
  update, wait for it and then run in order. This works from the first update made from this version on: the update
  to it still runs the earlier launcher and server.
- `sudo mycel-ctl update` says how many running answers it waits for. The answers still running when the wait ends are
  stopped by the engine launcher itself just before it restarts, so the server knows they ended.
