# Dev environment (experiment): box helper and test VM

Branch `feat/dev-env` only. Design and the review's seven holes: `docs/DECISIONS.md` "Dev environment (experiment)".
P0 numbers: `docs/research/dev-env-p0-spike.md` (branch `spike/dev-env-p0`).

| File | What |
|---|---|
| `Containerfile` | box image: Debian 13 slim, node/npm, python3/pip, git. No AI engine (the build fails if one is in it). |
| `make-seccomp.py` | box seccomp profile = podman default + the engine filter's denies (from the spike) |
| `build-image.sh` | root: seccomp profile to `/etc/mycel-boxd/`, image `localhost/mycel-devbox:1` for the box account |
| `vm-setup.sh` | root, TEST VM ONLY: accounts, stand-in team folders and targets, boxd as a transient unit |
| `vm-tests.sh` | root, TEST VM ONLY: isolation, network, limits, preview, stop, idle stop; PASS/FAIL lines |
| `boxctl.py` | small boxd client for the tests (run as the server stand-in account) |
| `in-box/isolation.sh` | the spike's isolation probe, sent into the box |

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
Do not install it on a shared server or a team server during the experiment: use the test VM
(`docs/research/dev-env-test-vm-plan.md`).
