- A bad release can now be paused before it reaches more servers and office Macs, without a new version:
  `bun scripts/release/hosting.ts hold stable --reason "…"` re-signs only the channel's small head files, and
  `hosting.ts resume stable` lets the staged roll-out go on where it stopped (docs/RELEASE-CI.md 6 "배포 멈추기").
  Servers and offices not on it yet stay on their version, and Admin › Home says "Updates are paused" for it; a server
  already on it keeps running it. A copy of the head from before the pause, served again, does not lift it.
