# Updates install mycel-ctl first; the unfinished-update message names the command that was used

QA TC-340 retest (VM reset in the middle of an update from a kit newer than the feed): `install-linux.sh` replaced
bootstrap, launcher and sandbox before mycel-ctl, and `mycel-ctl update` walks root files by name (account, bootstrap,
then ctl). A reset in between left new root programs with the old mycel-ctl, whose `status` has no
"AN UPDATE DID NOT FINISH" check. The new message also sent the administrator to `sudo mycel-ctl update`, which says
"already at 0.4.0" when the interrupted update came from a kit.

## Plan
- `scripts/install-linux.sh`: mycel-ctl is the first root program the loop installs.
- `native/cmd/mycel-ctl/update.go` `rootDiff`: mycel-ctl first, the rest in name order.
- Safe intermediate state (new mycel-ctl, old other root files): the Go path already had it for launcher, sandbox and
  the unit templates; the units on disk call only `firewall apply --base` and `update --base --only-if-needs-root
  --scheduled`, which every mycel-ctl takes; units are rendered only after all files are in; the firewall rules did not
  change with the netns change (5d9f1c8a9). A kept newer root (`ROOT_KEEP`) has the same pairing.
- `status.go`: the message says to run the same command again (a kit: `sudo ./install-linux.sh update --from .` in its
  folder), otherwise `sudo mycel-ctl update`.
- `update.go`: when the feed's release is not newer and root files are half replaced, `mycel-ctl update` (an
  administrator's run) fails with that reason instead of "already at"; the update timer only says why it skips.
- Docs: BACKUP-RESTORE.md going back (step 5 wording for 0.4.0, restore-staged.db on cancel), INSTALL-LINUX.md Korean
  steps (status right after start: wait and run again).
- Tests: Go tests for both orders, the message and the not-"already at" answer; check:docs, typecheck, shellcheck.

## Result
