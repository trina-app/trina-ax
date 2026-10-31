# Dev environment P0 spike: prototype

Throwaway prototype for the 개발 환경 spike. Not product code. Results and the P1 design:
[docs/research/dev-env-p0-spike.md](../../../docs/research/dev-env-p0-spike.md). Raw results: `results/`.

Run it only on a throwaway Linux VM (it adds accounts, a dummy network interface and stand-in services).

## Files

| File | What it does |
|---|---|
| `vm-setup.sh` | root: packages, accounts `mycel` (server stand-in) and `devbox` (box owner), team folders, stand-in secrets, stand-in network targets |
| `fake-target.py` | an HTTP listener that answers "REACHED <name>" (LAN, metadata, team server, local admin) |
| `box.sh` | the box: `fetch-claude`, `mkvol`, `grant` (root); `build`, `create`, `start`, `stop`, `exec`, `cgroup` (devbox) |
| `Containerfile` | box image: Debian 13 slim, node, npm, python3, git. No AI engine |
| `make-seccomp.py` | box seccomp profile = podman default + the engine filter's denies |
| `box-open.nft`, `box-allow.nft` | rules loaded into the box's network namespace |
| `model-proxy.py` | stand-in model proxy on a per-box unix socket: per-turn tokens bound to the box, scripted Bash answers |
| `egress-proxy.py` | allowlist proxy on a per-box unix socket: CONNECT to listed hosts, public addresses only, SNI check |
| `turn.sh` | one AI turn with Claude Code **in** the box |
| `turn-outside.sh`, `boxshell/bash` | one AI turn with Claude Code **outside** the box; only Bash enters the box |
| `preview.sh` | preview socket on the host into the box's network namespace |
| `measure.py`, `bench.sh` | measurements (wall, CPU, memory, OOM) |
| `bombs.sh` | fork bomb, memory bomb, CPU burn, disk fills |
| `in-box/` | mounted read-only at `/opt/trina` in each box: init, forwarder, probes (network, isolation, thief, mitm, plant) |
| `sample/` | sample projects: Vite/React (`web`), Next.js (`next`), Flask (`py`) |

## Steps (as run on 2026-10-31)

Host: a Debian 13 VM. The spike used an OrbStack machine on a Mac (`orb create debian:trixie devbox-spike`); any
Debian 13 VM with systemd works. Copy this folder to `/opt/spike` and the repository's
`scripts/linux/engines.lock.json` to `/opt/spike/engines.lock.json`. Make it readable (`chmod -R a+rX /opt/spike`).

As root:

```bash
/opt/spike/vm-setup.sh
/opt/spike/box.sh fetch-claude /opt/spike/engines.lock.json
for p in web py next; do cp -r /opt/spike/sample/$p/. /srv/trina/teams/proj-$p/ 2>/dev/null || { install -d -o mycel -g mycel -m 0750 /srv/trina/teams/proj-$p; cp -r /opt/spike/sample/$p/. /srv/trina/teams/proj-$p/; }; done
chown -R mycel:mycel /srv/trina/teams
for p in web py next; do /opt/spike/box.sh mkvol $p 6G; /opt/spike/box.sh grant $p proj-$p; done
printf 'pypi.org\nfiles.pythonhosted.org\nregistry.npmjs.org\n' > /srv/trina/secrets/allowlist-py; chown mycel /srv/trina/secrets/allowlist-py
```

As `devbox` (with `XDG_RUNTIME_DIR=/run/user/$(id -u)`, for example through `machinectl shell devbox@`):

```bash
/opt/spike/box.sh build
/opt/spike/box.sh create web proj-web open && /opt/spike/box.sh start web
/opt/spike/box.sh create next proj-next open && /opt/spike/box.sh start next
/opt/spike/box.sh create py proj-py allow && /opt/spike/box.sh start py
/opt/spike/box.sh exec web /opt/trina/net-probe.sh <host-ip> <gateway-ip>
/opt/spike/box.sh exec py /opt/trina/allow-probe.sh
/opt/spike/box.sh exec web python3 /opt/trina/netadmin-probe.py
/opt/spike/bench.sh web; /opt/spike/bench.sh next; /opt/spike/bench.sh py; /opt/spike/bench.sh life; /opt/spike/bench.sh disk
/opt/spike/bombs.sh web
```

As root (AI turns and the token probes):

```bash
/opt/spike/turn.sh web "ls" "git --version"
LOCK=1 /opt/spike/turn-outside.sh web proj-web "cd src && pwd" "pwd" "WRITE:/work/x.txt:hello"
# planted config: podman exec box-web /opt/trina/plant.sh hooks (or env), then turn-outside.sh with and without LOCK=1
# isolation probe, with a valid token of another box to show the proxy refuses it
OT=$(sudo -u mycel python3 -I /opt/spike/model-proxy.py issue py 600 true)
sudo -u devbox XDG_RUNTIME_DIR=/run/user/$(id -u devbox) podman exec -e OTHER_BOX_TOKEN=$OT box-web /opt/trina/isolation.sh
# token theft: start the thief (or mitm.py) in the box with `podman exec -d`, then run turn.sh / turn-outside.sh
```

Clean up: `orb delete devbox-spike` (or delete the VM).
