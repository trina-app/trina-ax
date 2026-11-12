# Linux update: check free space first, never leave the server stopped; Diagnostics reads os-release through its link

- Date (UTC): 2026-11-12 01:58
- Branch: `fix/installer-space-and-diag`
- Status: done
- Where: `scripts/install-linux.sh`, `native/cmd/mycel-ctl/`, `server/src/system/system-packages.ts` (Team AX core).
  Why: the Linux installer, the root update tool and Diagnostics are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, bug fixes with no new API or option

## Goal

QA TC-339 (Ubuntu 24.04, 0.4.0 -> 0.5.0, about 1 GB free): `install-linux.sh update` ran out of space while it copied
the new version, after it had stopped `mycel-server` and `mycel-launcher`. It exited 1 with both stopped, `root/VERSION`
already at the new version while the app was the old one, and a half-copied `app/versions/<v>.partial` filling the
disk. `mycel-ctl update` with 600 MB free failed cleanly but did not say how much space it needs.

Diagnostics: "System packages: Not yet brought to this version's list" stays after a successful sync on Debian and
Ubuntu: `/etc/os-release` is a link there (to `../usr/lib/os-release`), and the server's reader refuses links, so its
system name (`-/<machine-id>`) never matches the one the sync wrote.

## Scope

In:
- install-linux.sh (update and repair; install too): before anything stops, compare the free space of the install
  folder's file system with what the run writes there (the new version, root's copies, engines from outside that file
  system, a copy of the database the server makes before it migrates, and a margin). Refuse in plain words: "needs
  about X GB free, has Y GB; nothing was changed and the server keeps running".
- Copy the new version while the server still runs, into a root-only folder on the same disk (not into the server
  account's `app/versions/` while its processes run: they could swap a name under root's chown).
- After the units stop, any failure before `app/current` switches puts back root's files as they were (a hard-link
  copy taken before they change), removes the half-copied version and starts the units that ran before, then exits
  non-zero and says so. After the switch, the units are started again too (the bootstrap goes back to the previous
  version by itself when the new one does not start), except when the engine firewall step failed.
- mycel-ctl update: before the download, the same kind of check (the archive, unpacking it and the copy into
  `app/versions`, estimated from the archive and the version that runs), "needs about X, has Y".
- system-packages.ts: follow the link for `/etc/os-release` only (root's file); machine-id and root/ files keep lstat.

Out: putting back the engines and the headless browser the run switched (both keep working with the old version), and
other file systems than the install folder's (`/opt` for the browser: packages.sh checks its own space).

## Steps

1. Unit test for an os-release link (tests/unit/system-packages.test.ts); the fix in system-packages.ts.
2. install-linux.sh: space check, early staging, rollback trap (between BEGIN/END markers so a test can run it).
3. A unit test that runs the space check and the rollback with fake folders (Linux part in Docker where needed).
4. mycel-ctl: space check before download, Go test for the message.
5. Real check in a Lima Ubuntu 24.04 VM where possible; docs (INSTALL-LINUX.md, .en.md), changes/installer-space-check.md.

## Risks

Root runs the rollback: it only touches root's own folders (`root/`, the staging folder under the install folder) and
the version folder it created. A check that asks for too much refuses an update that would have fitted: the margin is
512 MB and the message says how much is needed. No migration, no API change, no app language strings.

## Result

- The space check runs twice: before the packages and downloads (step 2c) and again right before the stop. The new
  version is copied into `.install-stage` (root-only, 700) while the server runs; step 9 renames it in.
- The EXIT trap (`on_exit`) has three phases: `stopped` (root/ swapped back from a hard-link copy, the version folder
  this run added removed, the units that ran started again), `switched` (units started again), `started` (nothing).
  Ctrl-C and a closed SSH session go through it too.
- Lima VM, Ubuntu 24.04 arm64, real kits 0.4.0 -> 0.5.0-beta.1: 1 GB free -> refused ("needs about 1.2 GB free, it has
  1.0 GB"), units active, root/VERSION 0.4.0, no partial; a failure injected in step 7 after the stop
  (`chattr +i root/systemd`) -> root/ back to 0.4.0's files (launcher sha checked), no 0.5 folder, the units
  started again, health 0.4.0 (a launcher still starting was not counted as running: fixed, a repair run then listed
  all four); a normal update -> 0.5.0-beta.1 with about 2 s of server downtime. The VM found one bug
  that the plan did not foresee: a copy of root/ that stops half way (a file that cannot be linked) was put back
  incomplete; the copy is now made under another name and renamed when complete (test added).
- mycel-ctl in the VM with 600 MB free: before "write ...: no space left on device" (after a download); now "not
  enough free space for 0.4.0 on the disk of /var/lib/mycel: it needs about 1.4 GB free, it has 0.6 GB; nothing was
  changed" before the download.
- Review of #541: a leftover `app/versions/<v>.partial` (a box already hit by TC-339) is removed before the copy (after
  the update lock), a stale `.install-stage` counts as free; a second signal during the trap is ignored; a run without
  a switch keeps the new root files from the firewall step on (`committed`), and units are rendered from the new root
  files when a failure comes before step 13; a df that fails says so; mycel-ctl counts the database copy.
