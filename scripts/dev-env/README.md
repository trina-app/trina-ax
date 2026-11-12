# Dev environment (experiment)

Status: experiment, off by default. The AI's `box_shell` commands run in srt on the team server: install and remove it
with `srt/` (`srt/README.md`). Design: `docs/research/srt-dev-env.md`. Decisions: `docs/DECISIONS.md` "Dev environment
on srt, behind a flag" and "Dev environment: box runner removed, srt only".

The podman box runner (`mycel-boxd`, `install-trial.sh`, the box image and its VM tests) is removed. A server where
`install-trial.sh` ran: see `docs/INSTALL-LINUX.md` "Removed: the box runner".

Server switches (all off by default):

| Variable | Meaning |
|---|---|
| `MYCEL_DEV_ENV=1` | the feature exists (API, tool); without it every dev-env endpoint is 404 |
| `MYCEL_DEV_ENV_DENY_ADDRS` | more addresses of the team server (comma list) that a run may never reach, in addition to the ones it finds |
