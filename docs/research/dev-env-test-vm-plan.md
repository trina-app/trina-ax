# Dev environment: test VM plan (dev-env-test)

Status: approved by the owner 2026-10-31; run on another host (see "Results" at the end). Branch `feat/dev-env`.

Purpose: run the root and network tests of `mycel-boxd` (`scripts/dev-env/vm-tests.sh`) on a throwaway VM, not on
the shared Linux server and not on a team server. The shared server has no SSH trust to the pilot host (no known
host key), so a person or the main session runs these commands on the pilot host.

## Rules for the pilot host

- Do not touch `ax-hostd`, the tenant bridge `axnet`, tenant VMs (VMID 1000 and up) or the template (VMID 9000).
- Do not change the host firewall, host network files or host packages. The VM gets only per-VM settings.
- One VM, VMID **990**, name `dev-env-test`, tag `dev-env-test`. Teardown removes it and its disk.

## Step 0: look first (read only)

```bash
qm list                                    # VMID 990 must be free; note the tenant VMIDs
pvesm status                               # storage for the disk (below: local-lvm; change it if absent)
ip -br link; cat /etc/network/interfaces   # which bridges exist; axnet is the tenant bridge
pve-firewall status                        # per-VM firewall works only when the datacenter firewall is on
```

Stop and ask again if VMID 990 is taken, if there is no bridge other than `axnet` with internet, or if the
datacenter firewall is off (then option B below is not available and option A needs a decision).

## Step 1: make the VM (Debian 13 cloud image, 4 vCPU, 6 GB, 20 GB disk)

```bash
cd /var/lib/vz/template/iso
wget -nc https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2
sha512sum -c <(curl -fsS https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS | grep ' debian-13-genericcloud-amd64.qcow2$')
qm create 990 --name dev-env-test --tags dev-env-test --memory 6144 --cores 4 --cpu host \
  --net0 virtio,bridge=vmbr0,firewall=1 --scsihw virtio-scsi-single --agent 1 --ostype l26 --onboot 0
qm importdisk 990 debian-13-genericcloud-amd64.qcow2 local-lvm
qm set 990 --scsi0 local-lvm:vm-990-disk-0,discard=on --boot order=scsi0 --ide2 local-lvm:cloudinit \
  --ciuser tester --sshkeys /root/dev-env-test.pub --ipconfig0 ip=dhcp
qm resize 990 scsi0 20G
```

`/root/dev-env-test.pub`: a new key pair only for this VM (made on the machine that runs the tests).

## Step 2: network

The VM must reach the internet (apt, npm, pypi, example.com) and nothing else of ours.

- **Option B (recommended): `vmbr0` with the Proxmox per-VM firewall.** Only this VM's rules, in
  `/etc/pve/firewall/990.fw` (no host or datacenter rule changes):

  ```
  [OPTIONS]
  enable: 1
  policy_in: DROP
  policy_out: ACCEPT

  [RULES]
  IN SSH(ACCEPT) -source <tester address>/32
  OUT DROP -dest 10.0.0.0/8
  OUT DROP -dest 172.16.0.0/12
  OUT DROP -dest 192.168.0.0/16
  OUT DROP -dest 100.64.0.0/10
  OUT DROP -dest 169.254.0.0/16
  ```

  Add an `OUT ACCEPT -dest <gateway>/32` before the drops if the gateway of `vmbr0` is in a private range (DHCP and
  DNS go to it). The VM then cannot reach tenant VMs, the host's private addresses or the tailnet.
- **Option A: no internet.** `--net0` on a new bridge without uplink is a host network change, so not this plan.

Not `axnet`: the VM must not be on the tenant network.

## Step 3: run the tests (on the VM, as root)

Clone under `/opt`, not under `/root`: the server stand-in account `mycel` must read the scripts (`vm-setup.sh` and
`vm-tests.sh` stop otherwise). Run 1 failed on this.

```bash
cd /opt && git clone -b feat/dev-env https://github.com/trina-app/trina-ax.git && cd trina-ax
apt-get install -y golang-go bc time jq && (cd native && CGO_ENABLED=0 go build -o /tmp/mycel-boxd ./cmd/mycel-boxd)
scripts/dev-env/vm-setup.sh /tmp/mycel-boxd
scripts/dev-env/vm-tests.sh | tee /root/vm-tests.txt
LONG=1 scripts/dev-env/vm-tests.sh | tail -3      # also the idle stop (about 6 minutes)
REMOTION=1 scripts/dev-env/vm-tests.sh | tee /root/vm-tests-remotion.txt   # also a video render (about 2 minutes)
```

Copy `/root/vm-tests.txt` back into `scripts/dev-env/results/`. Expected time: 30 minutes. Load: one box with 1 CPU
and 1.5 GB at a time, on the VM's own 4 vCPU.

## Step 4: teardown (after the joint review, or at once if anything looks wrong)

```bash
qm stop 990 && qm destroy 990 --purge 1 --destroy-unreferenced-disks 1
rm -f /etc/pve/firewall/990.fw /root/dev-env-test.pub
rm -f /var/lib/vz/template/iso/debian-13-genericcloud-amd64.qcow2   # only if it was downloaded for this
```

Check after teardown: `qm list` has no 990; `ls /etc/pve/firewall/` has no `990.fw`.

## Results (2026-10-31)

Where: not on the pilot host. Step 0 found no bridge other than the tenant bridge `axnet`, so the stop rule applied.
The main session ran the tests on a throwaway AWS EC2 t3.large instead (Debian 13, kernel 6.12.113 cloud, 2 vCPU,
8 GB, same AWS account, not part of the pilot), and terminated it after the run. podman 5.4.2, xfs box volume,
conntrack present.

- Run 1: setup failed. The repo was cloned under `/root` (the `mycel` account could not read it) and `/usr/bin/time`
  was missing. Both are now checked before the tests start, and `vm-setup.sh` installs `time`.
- Run 2 (`/opt/trina-ax`): **50 PASS, 2 FAIL**. Log: `scripts/dev-env/results/vm-tests.txt` (setup:
  `results/run2.log`).

| Area | Result |
|---|---|
| Box start (ensure: volume, idmapped mount, create, start, rules) | 2.24 s, first start |
| Folder checks: second box while one runs, folder through a link, outside the team root | refused (PASS) |
| Isolation probe: other folders, secrets, host root, image and /etc writes, namespaces, mount, dmesg, io_uring, bpf, keyctl, perf, userfaultfd, ptrace, AF_PACKET/VSOCK/ALG | all PASS; CapEff 0, NoNewPrivs 1, seccomp 2 |
| No AI engine in the box | PASS |
| Files: stored as the server account, `sed -i` / `cp -p`, node_modules in the box volume | PASS |
| Network (open): internet; LAN, metadata, team server on the VM address, SMTP 25 refused; rules cannot be changed; destination log has the HTTPS destination | PASS |
| Exec: time limit, a stopped command is killed, background dev server listed | PASS |
| Preview socket: server account 0600, works, refused to another account | PASS |
| Memory bomb | OOM kill after 1.2 s, reported as `oom` |
| Offline: restart on network change, no internet | PASS |
| Teardown: no mounts left | PASS |

The two failures:

1. **"host path of the folder not in mountinfo": a known limit, not fixable with a bind mount.** mountinfo field 4
   of `/work` is the source path inside its file system (`/srv/mycel/team/projects/web`). Every bind mount shows it.
   The box sees the location of the team root and its own folder's path, nothing of other folders. The test now
   checks that boxd's own state paths do not show and prints the folder path as KNOWN. To shorten it to the path
   below the team root, put the team root on its own file system.
2. **"volume full stops at its size": a test bug that showed a product gap.** The process-flood step ended with
   `pkill sleep`, which also killed the box's main process (`sleep infinity`). The box stopped, so the flood step
   ended with exit 137 after 30.7 s and the volume test got "container state improper". Fixed in two places:
   - **boxd:** an exec into a box that stopped by itself now cleans up and answers `box_stopped`.
   - **Server:** `box_shell` then starts the box again and runs the command once more. The command had not run, so
     running it again is safe. Unit-tested.
   - **Test:** it kills only its own `sleep 30` processes, checks the box survives the flood and the pids limit, and
     adds a recovery test (kill the main process → `box_stopped` → ensure → exec works).

Re-run needed for: the changed flood, recovery and volume-fill steps, and the idle stop (`LONG=1`, not run). It needs
a throwaway Debian 13 host with root, as before, for about 30 minutes; no new host was approved.

## Remotion (2026-11-01)

Question: can a box render video for a customer (for example Remotion) inside the current limits? Answer: yes, after
one image change, and a real box confirms it (see "Real box" below). The render takes about 3 times longer in a real
box than in the stand-in, so use the real box numbers for time. The table below comes from a stand-in on the shared
server, a Docker container with the same image, limits and seccomp profile (differences and all lines:
`scripts/dev-env/results/remotion-standin.txt`). The stand-in tests nothing about isolation.

Remotion 4.0.539, one composition with text and SVG, no video or image inputs, 30 fps, 1280x720, 1 CPU:

| Memory limit | Length | Render | Peak, anon + shmem | Result |
|---|---|---|---|---|
| 1536 MiB | 5 s | 25.0 to 27.0 s (5 runs) | 977 to 1249 MiB | video correct, no OOM |
| 1024 MiB | 5 s | 30.6 s | 992 MiB | video correct, no OOM |
| 768 MiB | 5 s | stopped at 14.4 s | 696 MiB | OOM kill, no video |
| 1536 MiB | 60 s | 117.4 s | 1239 MiB | video correct, no OOM |

Install: 14 s for npm (peak 358 MiB) and 6 s for Chrome. Other peaks: 198 processes (limit 512), 45 MiB in `/tmp` (limit
256 MiB). Disk: 971 MiB of the 4 GiB volume (`node_modules` 790, cache 181). No limit change is necessary.

- **Image.** Without a change Chrome does not start (`libnspr4.so` is missing), and a box cannot use apt (read-only
  root). The image now has `libnss3`, `fontconfig`, `fonts-liberation` and `fonts-noto-cjk`: 187 MB more (691 to 878
  MB in Docker). The image rules forbid only an AI engine and a credential helper, so these are permitted. Chromium's
  other libraries are not necessary for this render. No system ffmpeg: Remotion brings its own, and its own Chrome.
  A frame of the video was examined: Hangul and Latin text are correct.
- **Concurrency.** Remotion's default chose 1 Chrome tab under the 1 CPU quota, so no flag is necessary.
- **Time limit.** `box_shell` stops a command after 120 s by default. In a real box a 5 s video needs 70.5 s, so the
  AI must set `timeout_sec` (at most 1800 s) or use `background` for a longer video. The stand-in's speed gave "about
  15 minutes of video per command"; that number was wrong for a real box. At the real speed the estimate is about 5
  minutes of simple video per command. No long video was measured in a real box.
- **Not measured:** video or image inputs, 1080p, audio, heavy effects. These can need more memory or time. The 768
  and 1024 MiB runs show the floor for this simple render only, so keep 1.5 GB for customers.
- **Licence.** Remotion is free for a company with up to 3 employees and for evaluation. A larger for-profit company
  needs a Remotion Company License. We do not ship Remotion: the customer installs it into the box, so the customer
  holds the licence.

## Real box run (2026-11-01)

The owner chose to run the tests on a team server: Debian 13, kernel 6.12.107, 2 vCPU, 3.8 GB, with `REMOTION=1` and
`LONG=1`. Logs: `scripts/dev-env/results/vm-tests-real-box-20261101.txt`, `results/run.log`. Result: **60 PASS, 3 FAIL.**

That server has a live Trina install. `vm-setup.sh` caused no port clash and no account clash. The dummy interface
held 169.254.169.254 on that host during the test. The host accounts and files, and that interface, were removed
after the run. The host stayed healthy during the flood. Do this again only with the owner's approval: the rule for
this experiment is still a throwaway host.

| Area | Result |
|---|---|
| Box start | 2.8 s |
| Isolation probe, folder checks, no AI engine, network, exec control, preview socket | all PASS |
| Memory bomb | OOM kill after 2.0 s, reported as `oom` |
| Idle stop (`LONG=1`, first run) | PASS |
| Box stopped by its main process: `box_stopped`, ensure, exec | PASS, but see failure 1 |
| Remotion, 5 s, 720p | PASS: render **70.5 s** (not the 26 s of the stand-in), npm 36.5 s, Chrome 13.3 s |
| Remotion memory | charged peak 1535 of 1536 MiB, unreclaimable peak 1035 MiB, no OOM kill |
| Remotion, other | 121 processes, 37 MiB in `/tmp`, disk 963 MiB, h264 1280x720, 150 frames, 5.0 s |

The charged peak is at the limit because the file cache fills all free memory; the kernel can take that back. The
unreclaimable peak is the number that matters, and 501 MiB stays free. Heavier videos have less margin.

The three failures:

1. **"box survives the process flood" and "pids limit holds": a test bug that showed a product gap.** The flood was
   a bash loop. At the process limit bash retries fork for 15 s, then ends with exit 254, and its `pkill` does not run.
   A copy of the same step under the same pids limit in Docker gave exit 254 after 17 s and left the box full; there,
   the box stayed `running`, and an exec could not enter until the 30 s sleeps ended. It was not an OOM kill (the
   exit has no `oom` signal). The process count line was not printed because bash ended first. **Not explained:** in
   the real box, `box_stopped` came a moment later, so the box had stopped. Docker does not show that, and the log does
   not say which step stopped it. That also means the PASS of "exec after the main process was killed" in this run
   proves nothing. Fixed:
   - **boxd:** before an exec it reads `pids.current` and `pids.max`. If the box stays at its limit for 5 s, boxd stops
     the box and answers `box_stopped: the box stopped because it stayed at its process limit`.
   - **Server:** `box_shell` starts the box again, runs the command, and tells the AI that the processes in the box
     ended.
   - **Test:** `in-box/flood.sh` forks until the kernel refuses, prints the count, and ends its own children. A new
     step holds the box at its limit and expects the stop with that reason. In Docker the flood forked 507 processes,
     ended with exit 0, and left 3 processes.
2. **"volume full stops at its size": a test bug.** The limit held: dd stopped at 4112711680 bytes (3.8 GiB).
   `No space left on device` is the first of dd's four lines, `tail -1` dropped it, and `rm` after dd hid the exit code.
   Confirmed in Docker with a small volume. The test now checks the error line and the size (at most 4 GiB).

**Re-run needed:** the flood, the new process limit step, the recovery steps and the volume step. The boxd stop path
ran only as a unit test of the limit check, never in a real box. About 10 minutes with `scripts/dev-env/vm-tests.sh`
(without `LONG=1` and `REMOTION=1`) on a throwaway host. No new host is approved.

## Owner decision (2026-11-01)

The default box limit is now 2.5 GB (2560 MiB) and 1 CPU, for more margin than the real box run showed. The numbers
above were measured at 1.5 GB. Dev mode needs a team VM of at least 4 GB: boxd refuses a VM below 3.5 GB (3584 MiB),
as a 4 GB VM reports about 3.8 GB. The trial on one team server follows `scripts/dev-env/TRIAL.md`.

