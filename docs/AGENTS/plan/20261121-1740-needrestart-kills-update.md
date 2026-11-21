# A root update on a hosted team server finishes and syncs the system packages

- Date (UTC): 2026-11-21 17:40
- Branch: `fix/needrestart-kills-update`
- Status: done
- Where: scripts/system/packages.sh. Why: every apt run of the one list goes through pk__apt (docs/REPOSITORY-RULES.md)
- Version impact: patch: a fix of the update on hosted servers; no new setting

## Goal

After the 0.6.0 update the hosted teams va-relay-test2 and diontest show System packages as warn and stay there. The
control plane lost the update's answer after about 53 s (guest_agent_timeout, "the guest agent restarted?").

Cause: 0.6.0 adds apt packages to the devenv group (#241). `mycel-ctl update` runs install-srt.sh in devEnvAfter, which
runs apt directly. The hosted image has needrestart with restart = 'a'. The running mycel-ctl is the old binary that the
root step just replaced (deleted executable), inside mycel-link.service's cgroup, so needrestart restarts mycel-link.
KillMode=control-group then kills the update before its deferred syncAfter: root/packages.synced keeps the 0.5.23 list,
the server says "not yet brought to this version's list", and a hosted server has no update timer to catch up.
qa.trina.app (no needrestart) ran the same update in 59 s and synced.

## Scope

In: a direct apt run (pk__apt without PK_APT_UNIT: install-srt.sh, install-linux.sh) sets NEEDRESTART_SUSPEND=1.
needrestart keeps its marker, so the next apt run that does not suspend it (the sync's own unit, unattended-upgrades)
restarts what needs it. The fix is in the new bundle's script, so it already works for the update into this release
(the old mycel-ctl runs the new install-srt.sh and packages.sh).

Out: teams already on 0.6.0 need one more `mycel-ctl update` from the control plane (the same version is enough:
syncAfter syncs a pending list). Excluding mycel-link.service in the image's needrestart config (needs a new AMI).

## Steps

1. pk__apt: NEEDRESTART_SUSPEND=1 for a direct apt run, with the reason.
2. Unit test: a direct run passes it to apt-get only; the sync's systemd-run does not.

## Decisions

none
