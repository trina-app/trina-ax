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
  path (`mycel-ctl update`: copyTree/repairTree), `install-linux.sh` and the AMI already set the modes.
- **Rule:** every path that installs a version folder sets folders 0755 and files 0644, or 0755 when the owner can
  execute them. These are the modes mycel-ctl's copyTree gives. They are not taken from the archive or the umask.
  Symbolic links are never followed. `UpdateManager.stage()` applies this to what it unpacks, and also to a version
  that was already staged.
- **Healing:** a Linux install repairs every version folder it owns in `app/versions/` when it starts, in the
  background. A 0.5.7 server stages 0.5.8 with its old code, so 0.5.8 arrives broken and heals when it starts. A
  version kept for Go back is healed too. `extractTar` itself keeps its umask-respecting behaviour for backup restores
  and imports, because their files belong to the server only.
