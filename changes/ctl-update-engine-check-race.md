- Linux servers: `mycel-ctl update` no longer reports "ok" for a new version that was rolled back at the very moment
  it was checked. The version answered the health check, the roll-back was recorded right after, and the update read
  that as "kept".
