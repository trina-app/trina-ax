# Dev environment on srt: Ubuntu 24.04 (AppArmor spike S6; result: stays off, the reason is polkit)

- Date (UTC): 2026-11-12 14:09
- Branch: `feat/srt-ubuntu-apparmor`
- Status: done
- Where: trina-ax, scripts/dev-env/srt and scripts/install-linux.sh. Why: the open installer and its dev environment
  are core (docs/REPOSITORY-RULES.md).
- Version impact: patch. Ubuntu 24.04 stays off; the installer gives the real reason, and install-srt.sh gets a check.
- Depends on: #614 (the installer runs install-srt.sh on Debian 13).

## Goal

Ubuntu 24.04 is the most common server system of customers. install-srt.sh stopped there with "needs an AppArmor
profile for srt's apply-seccomp (spike S6)". The first plan: a profile for apply-seccomp, then the dev environment on by
default on Ubuntu 24.04.

## Scope (after the VM run)

In: the real reason in install-srt.sh and install-linux.sh; no extra AppArmor profile; the bwrap check and an srt probe
with no_new_privs where user namespaces are restricted; tests; DECISIONS, INSTALL-LINUX, the srt README, a changelog
fragment.
Out: route A (template unit + StartUnit), after the preview PR (server/src/devenv/srt/system.ts).

## Steps

1. Profile and installer changes; kit built and installed on a temporary Ubuntu 24.04 EC2 VM.
2. The VM showed: apply-seccomp inherits <ID>-bwrap (no profile needed); polkit gets no unit name from systemd 255 for a
   transient scope, so the scope check fails.
3. Owner decision: route C. The profile is dropped; Ubuntu stays off with the real reason.
4. VM again with the final kit: install, the reason, uninstall --purge, nothing left.

## Risks

Debian 13 must not change: the new checks run only where the sysctl is 1, and Debian 13 has no such sysctl.

## Tests

tests/unit/g-srt-ubuntu.test.ts (the OS rules run in bash, the checks), g-scripts, g-bundle-linux, system-packages;
typecheck, check:docs, check:i18n; the VM run.

## Result

Ubuntu 24.04 stays off with the real reason (polkit on systemd 255). No AppArmor profile is added. Route A is the
follow-up (docs/DECISIONS.md "Dev environment on srt: Ubuntu 24.04 stays off").
