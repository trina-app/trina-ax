# Dev environment (개발 환경) P0 spike: results

Status: spike done 2026-10-31. Research and prototype only. No product code, no UI. Branch `spike/dev-env-p0`.
Prototype and raw results: [scripts/spike/dev-env-p0/](../../scripts/spike/dev-env-p0/README.md).
Input: Dion's 개발 환경 plan and our review (7 holes, 5 answers).

## 1. Result in short

- **The box design works.** One rootless podman box per project folder starts in 0.13 s, stops in 0.09 s, and
  pauses and resumes in 0.03 s. An idle box uses 10 MB of memory. All isolation tests passed (section 5).
- **1 CPU / 1.5 GB is enough** for a Vite/React project, a Flask project and a Next.js 15 project. The largest
  real need was 635 MB (Next.js dev server under load). No out-of-memory kill in normal work.
- **Do not run the AI engine inside the box.** A process that an earlier command left in the box can steal the
  next turn's model token in two ways (section 5.3). Run Claude Code outside the box, in the launcher's sandbox as
  today, and send only its Bash commands into the box. We tested this and it works (section 3.3).
- **Mount the team folder with an idmapped mount.** A plain bind mount breaks normal tools (`sed -i`, `cp -p`) and
  depends on ACLs that a `chmod` by the server removes.
- **Two limits are not solved by the box:** writes to the team folder have no size limit, and an "open" box can
  reach every public address, including the team server's public address if we do not list it.

## 2. Test bed

| Item | Value |
|---|---|
| Host | OrbStack Linux machine on an Apple M-series Mac, **arm64**, kernel 7.0.14-orbstack, 9 vCPU and 8 GB shared with the Mac |
| OS | Debian 13 (trixie), the recommended production OS |
| Box runtime | podman 5.4.2 rootless, crun 1.21, pasta (passt 2025-05-03), netavark, cgroup v2 with systemd |
| Delegated cgroup controllers | cpu, memory, pids (no io) |
| Accounts | `mycel` = stand-in server account (owns folders, secrets, proxies); `devbox` = owner of all boxes |
| Claude Code | 2.1.305 linux-arm64 from `scripts/linux/engines.lock.json`, size and SHA-256 checked, kept in `/srv/devbox/claude/<version>/`, mounted read-only. Not in the image. |
| Model | A stand-in model proxy (`model-proxy.py`) that answers with scripted Bash calls. No real model call, no AI credential anywhere in the test. |

Limits of these numbers:

- arm64 on a fast laptop core. Production VMs are x86-64 with slower cores. Expect build and install times to be
  1.5 to 3 times longer. Memory numbers move less.
- OrbStack machines share one kernel and mount the Mac home (`/Users`, `/mnt/mac`). The box does not see them
  (tested). A real VM does not have them.
- No IPv6 in the VM. The IPv6 rules are written but not tested.
- We did not touch potenlab.trina.app or any other server.

## 3. What we built

### 3.1 The box

`box.sh create` makes one container per project folder:

- Image: Debian 13 slim with node 20, npm, python3 (venv, pip), git, curl. 536 MB on disk. No AI engine.
- `--read-only` root, `/tmp` as tmpfs (256 MB), `--cap-drop=ALL`, `no-new-privileges`.
- Seccomp: podman's default profile plus the denies of our engine filter (`native/internal/seccomp`): new
  namespaces, mount, ptrace, cross-process memory, io_uring, bpf, perf, userfaultfd, keyring, module and clock
  calls. Differences from the engine filter: `listen()` is allowed (dev servers), and socket families are unix,
  inet, inet6 and netlink (`make-seccomp.py`).
- Limits: 1 CPU, 1.5 GB memory, no swap, 512 processes.
- User: the `devbox` account is root inside the box (`--userns keep-id:uid=0`), with no capabilities. Reason: crun
  must create the mount points for `node_modules` and `.venv` as box root.
- Mounts: the team folder at `/work` (idmapped, section 3.2); a box volume at `/cache` (HOME, npm and pip caches);
  `node_modules` and `.venv` from the box volume over the folder; Claude Code read-only; the per-box proxy sockets.
- Box volume: one xfs file system in a loop file per box (4 to 6 GB). A full volume stops only that box.
- PID 1 starts only the forwarders to the proxy sockets. All work comes in with `podman exec` after the network
  rules are loaded. If the rules do not load, `box.sh start` kills the box (fail closed).

### 3.2 The team folder: idmapped mount

Root makes an idmapped bind mount of the folder (`mount --bind --map-users <mycel>:<devbox>:1`). Inside the box the
server account's files belong to box root. What the box writes is stored on the host as the server account.

We tried a plain bind mount with ACLs first. It failed in three ways:

1. `sed -i` fails ("preserving permissions: Invalid argument"): the file owner is not mapped in the box. `cp -p`,
   some editors and some npm scripts do the same.
2. Re-creating a folder with `install -m 0750` (a `chmod`) reset the ACL mask. The box lost write access without
   any message.
3. Files that the box made belonged to `devbox` on the host, not to the server account.

The idmapped mount has none of these problems. It needs root (the launcher has it) and a file system with idmap
support (btrfs, ext4, xfs on kernel ≥ 5.19; tested on btrfs).

### 3.3 The AI engine: two ways, one is safe

**A. Engine in the box** (`turn.sh`). Claude Code runs in the box. It gets the per-turn token on fd 3 (as the
launcher does today) and calls the model through an in-box forwarder (`127.0.0.1:4000`) to the box's unix socket.
It works: Claude Code called Bash, read the result and finished the turn. But the token is not safe (section 5.3).

**B. Engine outside the box** (`turn-outside.sh`, recommended). Claude Code runs on the host in its own mount
namespace (a stand-in for the launcher's bwrap sandbox) with the box paths (`/work`, `/cache`) bind-mounted.
`CLAUDE_CODE_SHELL` points to a small `bash` wrapper (`boxshell/bash`) that runs the real bash in the box with
`podman exec -w "$PWD"`. Results:

- Bash commands run in the box (hostname `box-web`, box limits, box network).
- The working folder carries over between commands (`cd src` in one call, `pwd` = `/work/src` in the next),
  because HOME (shell snapshots) and `CLAUDE_CODE_TMPDIR` (the cwd file) are the same files on both sides.
- Read/Edit/Write of Claude Code act on the same folder from outside the box.
- The token never enters the box. The thief and the MITM probe got nothing.

In the spike the engine runs as `devbox` and calls podman itself. **P1 must not do this:** an engine with podman
access can start new containers with any mount of that account. P1 needs a launcher operation "run bash in box X
for turn T" that the engine calls instead (section 7).

### 3.4 Network

Two modes, both tested:

- **open**: pasta gives the box its own network namespace with internet access. `box-open.nft` is loaded into
  that namespace from the host side: reject RFC 1918, 100.64/10, loopback, link-local (169.254/16, also cloud
  metadata), multicast and reserved ranges, IPv6 ULA and link-local, and ports 25/465/587. DNS goes only to pasta's
  forwarder. Model calls do not use the network: they use the unix socket.
- **allowlist**: `--network none`; only loopback. The box reaches the internet only through the egress proxy
  (`egress-proxy.py`) on a per-box unix socket. The proxy allows only `CONNECT host:443` for hosts on the box's
  allowlist, checks that every address of the host is public (no DNS rebinding to inside addresses), and checks
  that the TLS SNI is the same host. It logs every decision.

### 3.5 Preview

`preview.sh` runs socat in the box's network namespace but in the host's file system. It makes a unix socket on the
host that connects to `127.0.0.1:<port>` in the box. This works for both modes and needs no host port. The
preview gateway (server side) connects to that socket. Note: Vite refuses unknown Host headers, so the gateway must
send `Host: localhost` (or the project sets `server.allowedHosts`).

## 4. Numbers

All with 1 CPU and 1.5 GB. "Real memory" = anonymous memory of the box cgroup (sampled every 0.2 s). "Cgroup peak"
also counts page cache, which the kernel gives back under pressure.

### 4.1 Projects

| Step | Wall | CPU time | Real memory peak | Cgroup peak |
|---|---|---|---|---|
| **Vite 6 + React 19** (111 packages, node_modules 82 MB) | | | | |
| npm install, cold cache | 3.6 s (13.8 s on the first run) | 2.3 s | 107 MB | 268 MB |
| npm install, warm cache | 1.6 s | 1.5 s | 187 MB | 358 MB |
| vite build | 1.6 s | 1.5 s | 172 MB | 371 MB |
| dev server: until it answers | 0.5 s | | | |
| dev server idle, 60 s | | 0.6 % of 1 CPU | 148 MB | 330 MB |
| dev server busy, 30 s (request loop + 10 file edits) | | 99 % (CPU limit) | 154 MB | 264 MB |
| **Next.js 15 + Tailwind 4** (284 packages, node_modules 572 MB) | | | | |
| npm install, cold cache | 51.8 s | 18.3 s | 566 MB | 1376 MB |
| next build | 20.0 s | 19.9 s (CPU limit) | 533 MB | 843 MB |
| next dev: first page | 6.2 s | | | |
| next dev idle, 60 s | | 3 % | 524 MB | 872 MB |
| next dev busy, 30 s | | 99 % (CPU limit) | 635 MB | 720 MB |
| **Flask** (allowlist box, pip through the egress proxy) | | | | |
| python -m venv | 1.2 s | 1.0 s | 67 MB | 109 MB |
| pip install, cold cache | 3.1 s | 0.7 s | 64 MB | 105 MB |
| flask: until it answers / idle 30 s / busy 20 s | 0.3 s / 0 % / 99 % | | 33 / 33 / 35 MB | 71 MB |
| **Claude Code turn in the box** (3 Bash calls, stand-in model) | 4.5 s | 1.2 s | 151 MB | 413 MB |

Real turns with long conversations use more engine memory than the stand-in turn. With the engine outside the box
(recommended) this memory is not in the box's 1.5 GB.

### 4.2 Box life cycle and fixed cost

| Item | Value |
|---|---|
| create (podman create) | 0.04 s |
| start (incl. network rules) | 0.13 to 0.16 s |
| start until the Vite dev server answers | 0.54 s |
| stop | 0.09 s |
| pause / resume | 0.03 s / 0.03 s; a paused box keeps its memory (170 MB in the test); dev server answers 0.08 s after resume |
| Idle box, no dev server | 10 MB real memory, 13 processes |
| Host helpers per box | conmon 1.5 MB; pasta 15.5 MB (open boxes only) |

### 4.3 Disk

| Item | Size |
|---|---|
| Box image (shared by all boxes) | 536 MB on disk (podman lists 1.26 GB because it adds layers twice) |
| Claude Code binary (shared, host cache) | 277 MB |
| Box volume, Vite project | 102 MB (node_modules 82 MB, caches 21 MB) |
| Box volume, Next.js project | 912 MB (node_modules 572 MB, npm cache 340 MB) |
| Box volume, Flask project | 23 MB |
| Build output in the team folder | Next.js `.next/` 62 MB, Vite `dist/` < 1 MB |

### 4.4 What this means for team VMs

- A 4 GB Team VM can hold one 1.5 GB box. Trina itself then has 2.5 GB. A Next.js install puts the box near
  1.4 GB including page cache; the kernel reclaims that cache, but the VM is busy for a minute.
- The 2 GB free tier and Basic cannot run a box with Next.js-size projects next to Trina. Small Vite/Flask projects
  need about 200 MB. Keep the review's answer: Team/Pro only in hosted P1.
- CPU is the limit for builds and dev servers under load (always 99 % of the 1 CPU). On a 2-vCPU VM a busy box
  takes half the VM. Keep 1 CPU per box and give the box a lower CPU weight than Trina.

## 5. Isolation results

### 5.1 Files, kernel, proxy (`isolation.sh`, results/isolation-web.txt): all PASS

| Test | Result |
|---|---|
| Read another team folder, server secrets, the Mac home mounts | Not there. The box sees only its folder, its volume, Claude Code (read-only), its proxy sockets. |
| Find the other folder's secret file anywhere in the box | Not found |
| podman socket and storage of the box account | Not visible |
| Host root through `/proc/1/root` | Box root only |
| Write the image or `/etc` | Read-only file system |
| Capabilities | CapEff/CapPrm/CapBnd = 0, NoNewPrivs = 1, seccomp on |
| `unshare -Ur`, `unshare -m`, mount, dmesg | Refused |
| io_uring, bpf, keyctl, perf_event_open, userfaultfd, ptrace | EPERM |
| AF_PACKET, AF_VSOCK, AF_ALG sockets | Refused |
| Model proxy: unknown token / a valid token of another box | 401 / 401 |
| Change the box's network (rtnetlink, nftables flush) | EPERM (`netadmin-probe.py`) |

Small leak: `/proc/self/mountinfo` shows the host path of the folder (`/srv/trina/teams/proj-web`). In P1 use
neutral host paths (box id, not folder names).

### 5.2 Network (`net-probe.sh`, `allow-probe.sh`)

Without rules, pasta gives the box much more than "internet":

| Target from the box | No rules | open mode | allowlist mode |
|---|---|---|---|
| Internet (https://example.com) | yes | yes | only through the proxy, only listed hosts |
| "LAN" host 10.99.0.1 | **reached** | blocked | blocked |
| Cloud metadata 169.254.169.254 | **reached** | blocked | blocked |
| Team server on another host address (`host.containers.internal`) | **reached** (a 0.0.0.0 listener) | blocked | blocked |
| Team server on the host's main address | no (pasta copies that address into the box) | blocked | blocked |
| Gateway | reached | blocked | blocked |
| SMTP port 25 on the internet | open | blocked | blocked |
| DNS | yes | yes (pasta forwarder only) | no (not needed: the proxy resolves) |

Allowlist proxy: pypi.org and registry.npmjs.org allowed; github.com (not listed), plain HTTP, CONNECT to pypi.org
with SNI github.com, and 169.254.169.254 refused. Every decision is in the egress log.

Important: pasta reaches every address that the host can reach, also the host's own other addresses. The box rules
are the only barrier. They must load before any workload, and the box must stop if they do not (done in `box.sh`).

### 5.3 Token theft (engine in the box)

| Attack by a process left in the box | ptrace_scope 0 (Debian default) | ptrace_scope 1 |
|---|---|---|
| Read the engine's environment | no token (fd 3 only) | no token |
| Read the engine's fd 3 | refused / closed | refused |
| Read the engine's memory (`/proc/<pid>/mem`) | **token stolen** | refused |
| Replace the in-box forwarder on 127.0.0.1:4000 (MITM) | **token stolen** | **token stolen** |

All processes in a box are the same user, so the box cannot protect one process from another. The fix is design,
not a setting: the engine runs outside the box (section 3.3 B). With that design both attacks get nothing.

A stolen token is bound to the box (the proxy refused it on another box's socket) and is revoked at the end of the
turn. It still lets code in the box use another member's model budget during that member's turn.

### 5.4 Resource abuse (`bombs.sh`, results/bombs.txt)

| Attack | Result | Host during the attack |
|---|---|---|
| Fork bomb, 15 s | Stopped at 512 processes (5777 refused forks); box killed in 0.27 s and started again | small command 21 ms (30 ms before); load average 80 but no slowdown |
| Memory bomb (64 MB steps) | OOM kill at 1.5 GB, exit 137, no swap used | 7 ms |
| CPU burn, 4 loops | 0.99 CPU used (limit 1), throttled | 7 ms |
| Fill the box volume | ENOSPC at 4.0 GB (only that box) | not affected |
| Fill /tmp | ENOSPC at 256 MB (counts as box memory) | not affected |
| Write to the team folder | **No limit.** 512 MB written; df shows the host disk (30 GB free). Not filled on purpose. | — |

## 6. What did not work, and what we changed

| Problem | Change |
|---|---|
| crun could not create mount points in the folder (box root had no access) | `devbox` = box root (no capabilities); mount points made at grant time |
| Plain bind mount + ACL: `sed -i` fails, `chmod` removes access | Idmapped mount (section 3.2) |
| `--network none` leaves loopback down | `ip link set lo up` from the host side at start |
| pasta's `host.containers.internal` reaches host services | `--map-guest-addr none`, `--no-map-gw`, and the box rules |
| `sudo` closes inherited descriptors, so fd 3 did not reach podman | the token goes on stdin to the box account's shell, which moves it to fd 3 |
| Engine in the box: token theft and MITM | engine outside the box, `CLAUDE_CODE_SHELL` wrapper |
| `memory.current` looked like 650 MB idle | page cache; report anonymous memory separately |
| In open mode we have no list of destinations: pasta connects as the box account and nft logs in a non-initial namespace are off by default | P1: per-box connection log (pasta has none); or open mode also through the egress proxy with "allow all, log all" |

## 7. Recommended P1 design

1. **Box host.** On the team server, a dedicated `devbox` account (never the server or engine account) owns all
   rootless podman boxes. One box per project folder, made when an owner turns the dev environment on. Debian 13
   first. Check Ubuntu 24.04 before release: its default `apparmor_restrict_unprivileged_userns=1` may block
   rootless podman (not tested).
2. **Launcher operations** (root launcher, over its socket; the server never runs podman): `box-create`,
   `box-start` (loads the rules, fails closed), `box-stop`, `box-pause`, `box-exec(box, turn, cwd)` for one Bash
   process, `box-preview(box, port)`. The engine calls only `box-exec` for its own turn's box. Nothing else gets
   podman access.
3. **Engine outside the box.** The turn runs as today in the launcher's bwrap/Landlock/seccomp sandbox, with the
   project folder (idmapped) at `/work` and the box's `/cache` mounted, and `CLAUDE_CODE_SHELL` set to the
   `box-exec` client. The token stays on fd 3 outside the box. The model proxy keeps its TCP peer check, because the
   engine still runs in the launcher sandbox on the host.
4. **Folder.** Idmapped bind mount (server account → box root). `node_modules`, `.venv` and caches in the box
   volume. Build outputs (`.next/`, `dist/`) stay in the folder but versioning skips them (hole 4). Add a folder size
   limit for dev-environment folders: an xfs project quota, a btrfs qgroup, or a watcher that stops the box at the
   team's storage limit.
5. **Box volume.** One size-limited file system per box (4 GB default; 6 GB for Next.js-size projects). A full
   volume stops only that box.
6. **Network.** Default open mode with `box-open.nft` in the box namespace, plus the team server's public addresses
   in the reject list (filled in at start from the host's addresses). Allowlist mode with the egress proxy for teams
   that want it. Both proxies on per-box unix sockets, so the socket tells which box calls.
7. **Limits.** 1 CPU (lower CPU weight than Trina), 1.5 GB, no swap, 512 processes, /tmp 256 MB. Stop a box after
   N minutes without a turn or preview request; pause is cheap but keeps memory, stop frees it and starts in 0.13 s.
8. **Kernel setting.** Set `kernel.yama.ptrace_scope=1` on team servers anyway. It is not needed with the engine
   outside the box, but it removes one attack between processes of one account.
9. **Preview.** A separate registrable domain, a short-lived token, and the gateway connects to the box's preview
   socket (section 3.5) with `Host: localhost`.

## 8. Answers to the 7 holes

1. **Secrets between members of one box.** Confirmed by test: every process in a box can read every other
   process's memory (ptrace_scope 0) and can put itself between a tool and its socket. So no per-person secret may
   be in the box, not even for one turn. Model tokens: keep the engine outside the box. Git push and other
   per-person credentials: a credential helper in the box that asks Trina per command through a per-box socket;
   Trina checks the person of the current turn and, for push, asks that person to confirm. The helper must not give
   a reusable token to the box (Trina does the push or gives a token that works once for one repository).
2. **Shared code can be poisoned.** The spike does not change this risk; the box makes it real. Keep the review's
   answer: show "changed by A since your last turn" before a turn that will use person B's credentials, and keep an
   audit of who changed what. New: a process that A's turn left running (dev server, watcher, `nohup`) still runs
   during B's turn. Show running background processes at the start of a turn, and give "restart box" as one click.
3. **The preview runs arbitrary code.** The spike confirms the path works without host ports (unix socket in the
   box namespace). Keep: separate registrable domain, short-lived token, no Trina cookies. Add: the gateway sets
   `Host: localhost` (Vite refuses other hosts).
4. **"Record changes at the end of each answer" is not enough.** Confirmed: the dev server, the build and npm write
   at any time, and a Next.js build writes 62 MB into the folder. With the idmapped mount all writes come from the
   server account's uid, so a file watcher in the server sees them; it cannot tell who wrote them. Use hash-based
   versions on a debounce, skip `.gitignore` entries, `node_modules`, `.next`, `dist`, `.venv`, `.git`, `.env*` by
   default, and check for conflicts with edits from Files.
5. **Resources on the team VM.** Numbers in section 4.4: 1.5 GB is enough for one Next.js project, an idle box is
   10 MB, but install and build take the full CPU. Team/Pro only (4 GB+), one box running at a time, stop idle
   boxes. Free and Basic: no.
6. **Claude Code licence.** Done in the spike: the image has no engine. The box host downloads Claude Code from the
   official URL with the version, size and SHA-256 in `engines.lock.json`, keeps it in a host cache and mounts it
   read-only (or, with the engine outside the box, does not mount it at all).
7. **"Audit: commands".** Realistic, as the review says: the Bash tool calls of each turn (the launcher's
   `box-exec` sees every command and its person), egress decisions (allowlist mode: the proxy log has every host),
   changed files. Open mode has no destination log yet (section 6); this is a P1 task. Processes that a command
   starts in the background are not audited one by one.

## 9. What this means for "run code on the user's own machine" (runner)

- The cost on our servers is small when idle (10 MB, 0.13 s start) and large when busy (a full CPU for builds and
  dev servers, up to 1.4 GB with cache for one Next.js install). The hosted cost is the busy time, not the box.
- Most of the security work is the same in both cases: per-person secrets, poisoned shared code, preview isolation,
  file versions. A runner removes our network risks (no shared egress IP, no team server or metadata in reach) and
  our CPU cost, but it adds the user's own machine to the risk of shared code: member B's runner runs code that
  member A changed.
- The engine-outside-the-box design fits both: the engine stays in Trina's launcher, and `box-exec` can go to a
  local box or to a runner. Build `box-exec` as an interface so that P1 can use either.

## 10. Not tested

- x86-64 and a real 4 GB team VM (numbers will be slower).
- IPv6 rules; podman on Debian 12 and Ubuntu 24.04 (AppArmor user-namespace restriction).
- Real model calls and long conversations (engine memory).
- The real launcher integration (`box-exec` operation, bwrap with the box paths) and the real model proxy.
- Folder size limits (quota) and the file watcher for versions.
- Many boxes at once on one host, and a box start after a host reboot (linger, rules).
