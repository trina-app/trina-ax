- An answer that an update cuts off now says "This answer stopped because Trina was updating. Send it again." instead of
  "The AI engine stopped unexpectedly". Its chat and its place in the queue are free at once (before, the turn slot was
  held for a while after `mycel-ctl update` restarted the engine launcher), and messages waiting in the queue run after
  the update, in order.
- `sudo mycel-ctl update` says how many running answers it waits for. The answers still running when the wait ends are
  stopped by the engine launcher itself just before it restarts, so the server knows they ended.
