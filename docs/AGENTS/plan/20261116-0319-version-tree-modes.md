# Linux app-only update: the new version folder stays readable by the engine account

- Date (UTC): 2026-11-16
- Branch: `fix/version-tree-modes`
- Status: in progress
- Where: trina-ax (core: server updater, `server/src/system/`). Why: the update path is core (docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix

## Goal

After the 0.5.7 app-only auto-update (root 0.5.5, feed rootSince 0.5.5), `app/versions/0.5.7` came out
`drwxr-x---` with files 0640/0750. The launcher and the engine sandbox run as the engine account (axagent), which then
cannot bind `app/current/native/mycel-bridge`: every AI turn fails in about 0.5 s with a bwrap "Permission denied".

Root cause: the release archives are fine (0644/0755 in 0.5.5, 0.5.6 and 0.5.7). The server stages an app-only update
itself as the server account under umask 027 (`supervise_linux.go`, `server.service.in` UMask=0027).
`UpdateManager.stage()` makes the staging folder with `mkdir(mode 0o755)` and `extractTar` creates files with
`open(O_CREAT, mode)`, and both of those apply the umask. Subfolders are chmod'ed and stay 0755. The root path
(`mycel-ctl update`: copyTree/repairTree), `install-linux.sh` (umask 022, `cp -a`, chmod) and the AMI build are not
affected.

## Scope

In:
- `stage()`: after unpacking, set the modes of the staged tree whatever the umask is (folders 0755; files 0755 when the
  owner can execute them, otherwise 0644; symlinks are left alone). This is the rule `mycel-ctl`'s copyTree/repairTree
  uses.
- Healing at start-up: an installed Linux server repairs the same modes on every folder in `app/versions/` it owns, in
  the background. A server already broken on 0.5.7 (or a 0.5.8 staged by 0.5.7's old code) is healed when the new
  version starts, and a version kept for Go back is healed too.
- Tests: stage under umask 027/077 with an archive holding 0640/0750 entries, then check the result is o+rX. A start-up
  repair test.

Out: the root bootstrap and mycel-ctl (already normalize, and root files need a root update); `extractTar`'s backup
restore semantics (unchanged).

## Result

(filled in at the end)
