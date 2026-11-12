# Dev environment on srt: Ubuntu 24.04 (AppArmor profile for apply-seccomp)

- Date (UTC): 2026-11-12 14:09
- Branch: `feat/srt-ubuntu-apparmor`
- Status: in progress
- Where: trina-ax, scripts/dev-env/srt and scripts/install-linux.sh. Why: the open installer and its dev environment
  are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. A self-install on Ubuntu 24.04 gets the dev environment, a new feature for those servers.
- Depends on: #614 (the installer runs install-srt.sh on Debian 13).

## Goal

Ubuntu 24.04 is the most common server system of customers. Today install-srt.sh stops there: Ubuntu restricts
unprivileged user namespaces with AppArmor (kernel.apparmor_restrict_unprivileged_userns=1), and srt's apply-seccomp
helper makes a nested user namespace. After this change the dev environment works on Ubuntu 24.04, and the installer
turns it on by default, as on Debian 13.

## Scope

In:
- `scripts/dev-env/srt/apparmor-srt.in`: one profile `trina-srt` that gives `userns` only to srt's apply-seccomp
  (/opt/trina/srt/<version>/.../vendor/seccomp/<arch>/apply-seccomp). The global sysctl stays on.
- install-srt.sh: accept Ubuntu 24.04; where the sysctl is 1, write and load the profile, and check that bwrap can make a
  user namespace as the server account. srt runs /usr/bin/bwrap, which the installer's `<ID>-bwrap` profile covers
  already; no second bwrap profile (two profiles on one path cancel each other).
- uninstall-srt.sh and `install-linux.sh uninstall` remove the profile.
- install-linux.sh: the dev environment is on by default on Debian 13 and Ubuntu 24.04.
- The kit and image file lists carry the new template.

Out: Debian 12; other Ubuntu releases; changes to srt itself.

## Steps

1. The profile template and install-srt.sh / uninstall-srt.sh.
2. install-linux.sh: the DEVENV_ON rule, the uninstall fallback, comments and help text.
3. build-bundle.ts and build-ami.sh file lists.
4. Unit tests: the template (attachment path = the path install-srt.sh checks), the OS rule, uninstall.
5. Docs: DECISIONS entry, INSTALL-LINUX note, changes/srt-ubuntu-apparmor.md.
6. A real run on a temporary Ubuntu 24.04 EC2 VM: kit build, install, a real run through the server, uninstall --purge,
   vm-check.sh.

## Risks

- AppArmor exec transition from the bwrap profile to trina-srt under NoNewPrivileges may be refused. The VM run checks a
  real run that the server unit starts, and the label of apply-seccomp.
- Debian 13 must not change: the profile is written only where the sysctl is 1.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit/g-scripts.test.ts,
tests/unit/dev-env-srt.test.ts, tests/unit/g-bundle-linux.test.ts, tests/unit/system-packages.test.ts; the VM run.

## Result

(at the end)
