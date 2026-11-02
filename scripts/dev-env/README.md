# Dev environment (experiment): box helper and test VM

Status: experiment, off by default. Design and the review's seven holes: `docs/DECISIONS.md` "Dev environment (experiment)".
P0 numbers: `docs/research/dev-env-p0-spike.md` (branch `spike/dev-env-p0`).

| File | What |
|---|---|
| `Containerfile` | box image: Debian 13 slim, node/npm, python3/pip, git, NSS and fonts for headless Chrome, ffmpeg with libass. No AI engine (the build fails if one is in it). |
| `make-seccomp.py` | box seccomp profile = podman default + the engine filter's denies (from the spike) |
| `build-image.sh` | root: seccomp profile to `/etc/mycel-boxd/`, image `localhost/mycel-devbox:1` for the box account. A running box does not stop; it takes the new ones at its next start. |
| `vm-setup.sh` | root, TEST VM ONLY: accounts, stand-in team folders and targets, boxd as a transient unit |
| `vm-tests.sh` | root, TEST VM ONLY: isolation, network, limits, preview, stop, idle stop; PASS/FAIL lines. `REMOTION=1` adds a video render. |
| `boxctl.py` | small boxd client for the tests (run as the server stand-in account) |
| `TRIAL.md`, `install-trial.sh`, `uninstall-trial.sh` | root, one existing team server, owner approval only: install on a release, update, move an older install, remove, go back |
| `in-box/isolation.sh` | the spike's isolation probe, sent into the box |
| `in-box/flood.sh` | process flood, sent into the box: forks until the kernel refuses, then ends its children |
| `in-box/remotion.sh` | render probe, sent into the box: 5 s of 720p; time, memory, disk |

Server switches (all off by default):

| Variable | Meaning |
|---|---|
| `MYCEL_DEV_ENV=1` | the feature exists (API, tool); without it every dev-env endpoint is 404 |
| `MYCEL_BOXD_SOCK` | path of `boxd.sock` |
| `MYCEL_DEV_ENV_DENY_ADDRS` | the team server's public addresses (comma list), rejected from open boxes |
| `MYCEL_DEV_PREVIEW_ORIGIN` | `https://*.<preview domain>`: a wildcard host on a domain of its own, never the app's |
| `MYCEL_DEV_PREVIEW_LISTEN` | `host:port` of the preview gateway listener (behind the wildcard host's proxy) |

boxd needs: Linux 5.19+, cgroup v2, rootless podman for the box account (`loginctl enable-linger`), util-linux 2.39+
(`mount --map-users`), nftables, iproute2, xfsprogs or e2fsprogs, conntrack (destination log, optional). It runs as root.

The Linux kit ships it as `root/mycel-boxd`. The installer and `mycel-ctl update` put it in `<base>/root/`, and root owns
it there. It never runs from a version folder: the server account owns those folders. The file alone changes nothing:
the dev environment needs the `mycel-boxd.service` unit and `MYCEL_DEV_ENV=1`, and only `install-trial.sh` adds them.

Do not turn it on on a shared server. A team server needs the owner's approval (`TRIAL.md`). For tests, use the test VM
(`docs/research/dev-env-test-vm-plan.md`).
