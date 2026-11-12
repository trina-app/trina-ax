# Dev environment on srt: a run reads only what it needs on the host

- Date (UTC): 2026-11-12 01:18
- Branch: `fix/srt-deny-host-paths`
- Status: in progress
- Where: `server/src/devenv/srt/` (config.ts, runner.ts). Why: the Linux run base is core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a security fix with no setting or UI change

## Goal

QA TC-306. A member's dev environment command (box_shell on srt) could read host files outside the team folder: the
source folder behind a connected folder (a NAS mount under /mnt, including sub-folders the member cannot see through
the team folder), other apps' files under /srv and /opt, host service units with their tokens under /etc/systemd,
and could list /var/lib. The settings hid a short deny list only (/tmp, /var/log, /run, /home, /root and the base
folder); everything else on the host was readable.

## Scope

In: the srt settings switch to an allow-list for reads. `denyRead` gets `/` (srt expands it into the root's
children, skipping /proc, /dev and /sys), and `allowRead` gives back only the system places a run needs: /usr (and
/bin, /lib, /lib64, /sbin, which point into /usr on Debian 13), /etc and the Trina tools in /opt/trina. Inside /etc,
host secrets stay hidden: /etc/systemd, /etc/cloudflared, /etc/ssh, /etc/polkit-1, /etc/sudoers.d, /etc/letsencrypt,
/etc/ssl/private, /etc/default/<ID>. The person's team folders, home, logs and work folder are given back as before.
Every connected folder's source (from the database) is denied by name too, and `settingsProblems` refuses a run when
`/` or a source is not hidden.
Out: the network. Outbound public internet with the person's Full internet switch on is the owner's design, not
changed.

## Steps

1. config.ts: `SYSTEM_READ_PATHS`, `DENIED_SYSTEM_PATHS` (adds `/` and the /etc secrets), `hiddenPaths` input
   for connected sources; `settingsProblems` checks.
2. runner.ts: pass the connected folders' sources.
3. Unit tests on the settings (tests/unit/dev-env-srt.test.ts).
4. Docker attack suite (tests/linux/srt-attack.ts): reads of /mnt, /srv, /opt/other, /etc/systemd fail; bun, node,
   python, git and an npm install in the home still work.

## Risks

A tool that reads a host path outside the list now fails in a run (for example /var/lib or /usr/local outside /usr).
srt's allow-list needs the Docker suite to prove it; no migration, no UI, no languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the devenv unit tests, the srt Docker suite.

## Result
