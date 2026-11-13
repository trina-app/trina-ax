- A team server on a Mac (`scripts/install-macos.sh`, a team's own Mac mini, one team) now has the dev environment:
  the AI's commands run in srt's macOS sandbox (Seatbelt), each run as its own dev account (`_axdev1` ... `_axdev8`),
  never as the server account. The installer turns it on by default; `--no-dev-env` keeps it off and removes it, and
  `uninstall-macos.sh` removes it too. A failure is a warning: the server runs without it. Office mode (no sudo) stays
  without it.
- On a Mac a dev server must listen on `$PORT` (each run has its own port; no other localhost port works). The server
  reaches it there directly, for a later preview link.
- Weaker than Linux on a Mac: memory is watched (RSS once a second) instead of a cgroup limit, there is no CPU quota
  (runs get a lower priority), and a run can see the names of the folders above the ones it may open.
