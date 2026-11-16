# Version folders get fixed modes when they are installed, whatever the umask and the archive

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/version-tree-modes (release coordinator; potenlab.trina.app after the 0.5.7 auto-update)

Plan: docs/AGENTS/plan/20261116-0319-version-tree-modes.md.

- **What broke:** an app-only update is staged by the server itself, as the server account, with umask 027. The
  staging `mkdir` and `extractTar`'s file `open` applied that umask, so `app/versions/<v>` came out 0750 and its
  files 0640/0750. The launcher and the engine sandbox run as the engine account and bind
  `app/current/native/mycel-bridge`, so every AI turn failed. The release archives were fine (0644/0755). The root
  path (`mycel-ctl update`: copyTree/repairTree) already set the modes. `install-linux.sh` set folders only: files kept
  the kit's modes, so `repair` of a broken 0.5.7 copied 0640/0750 back.
- **Rule:** every path that installs a version folder (the server's stage(), mycel-ctl, install-linux.sh) sets folders
  0755 and files 0644, or 0755 when any execute bit is set. These are the modes mycel-ctl's copyTree gives. They are not taken from the archive or the umask.
  Symbolic links are never followed. `UpdateManager.stage()` applies this to what it unpacks, and also to a version
  that was already staged.
- **Healing:** a Linux install repairs `app/versions/` and every version folder it owns there at the top of start-up,
  synchronously, before migrations and before anything listens, so the bootstrap's health check and the first AI turn
  never see a broken tree. A 0.5.7 server stages the next version (0.5.9) with its old code, so that version arrives
  broken and heals as it starts. A
  version kept for Go back is healed too. `extractTar` itself keeps its umask-respecting behaviour for backup restores
  and imports, because their files belong to the server only.
