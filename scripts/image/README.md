# Trina AX tenant-template tooling (`scripts/image/`)

Maintainer tooling for a qcow2 tenant template; this source does not promise an official production Docker or VM image download. The template uses Debian 13 "trixie" genericcloud and the Linux kit installed in
image mode + the first-boot pieces (`mycel-enroll`).

| File | What |
|---|---|
| `build.sh` | Builds `teamax-<kitVersion>-debian13-<arch>.qcow2` (+ `.sha256`, `.sig`, manifest `.json`) with libguestfs |
| `customize.sh` | Runs **inside** the image as root (virt-customize). Idempotent: the second run prints `changed=0` |
| `files/` | Units, udev rule, cloud-init lock, sysctl, zram, chrony, journald, unattended-upgrades, needrestart |
| `pve-import.sh` | Manual import on a Proxmox host as template `tmpl-ax-<version>` (what ax-hostd `installTemplate` does) |
| `build-ami.sh` | Builds the same image as an EC2 AMI (Seoul, t3a) + a signed manifest `teamax-<templateVersion>.ami.json` (section "EC2 image (AMI)") |
| `ami-chroot.sh` | Runs on the AMI builder instance: grows the work volume and runs `customize.sh` in a chroot on it |
| `ami-manifest-v2.sh` | No build: copies a built AMI to more regions and/or writes the signed v2 manifest `teamax-<templateVersion>.v2.ami.json` (one AMI per AWS region) for a hostd with several regions (section "Several regions: the v2 manifest"). Also `build-ami.sh --manifest-v2 …` |
| `test-customize.sh` | Local proof without KVM: customize twice in a privileged Debian container + `vm-smoke.sh --container` |
| `../../tests/linux/vm-smoke.sh` | H-05 done-when checks, run inside a VM booted from the template |

## What is in the image

- **Accounts first, fixed ids**: `axserver` uid/gid **980**, `axagent` **981** (system range → the launcher's
  `checkDedicated` accepts the engine account, `native/cmd/mycel-launcher/main.go:65-77`). They are created before any
  package install (systemd-sysusers hands out system ids from 999 down) and are the same in every template version, so
  the files on a tenant's data disk keep their owners when `reimageTenant` swaps the OS disk. Not 990/991: the Debian 13
  genericcloud base already uses 988-999 (pilot 2026-10-30: uid 990 = systemd-resolve). If a later base image takes
  980/981, `customize.sh` stops with `uid N is taken by <account>`.
- Packages: all from the one list `scripts/system/packages.json` (read by `scripts/system/packages.sh`; the stage
  copies both as `system/`), so the image and a self-hosted install cannot drift apart (`tests/unit/system-packages.test.ts`):
  - `customize.sh` installs the list's `image` group (the VM's own: `qemu-guest-agent chrony nftables bubblewrap
    systemd-zram-generator unattended-upgrades needrestart ca-certificates e2fsprogs cloud-guest-utils`, systemd, udev,
    tzdata …) and purges its `remove` list (`openssh-server`, D15; `ssh.service`, `ssh.socket`, `sshd.service` masked).
  - The kit's installer (`install-linux.sh --image-mode`, without `--minimal`) installs the `always` and `default`
    groups, exactly as a self-hosted install: the server's packages, CJK fonts, the dev environment's tools and the
    pinned `chrome-headless-shell` in `/opt/trina/chrome-headless-shell/<version>` (`current` link,
    `MYCEL_HTML_PDF_BROWSER` in `/etc/default/mycel`).
  - With `--srt`, `install-srt.sh --image-mode` adds the `srt` group: node and srt at the list's versions and sha256.
  - Versions: the image is Debian 13 (the list's `debian-13`, suite trixie); floors (`>=`) are checked after the install
    and the newest trixie version is installed. `--apt-snapshot YYYYMMDDTHHMMSSZ` (`build.sh`, `build-ami.sh`,
    `customize.sh`) installs every apt package from that snapshot of snapshot.debian.org instead (apt's `--snapshot`),
    so a rebuild gets the same versions; it freezes security fixes at that time too, so use a recent one.
  - A change to the list is a root change of the kit (`root/packages.json`): `mycel-ctl update` on a team VM runs
    `packages.sh sync` (missing packages, the browser at the pinned version, the old one removed).
- **Kit in image mode, moved to the seed** (decision L1): `install-linux.sh install --from <kit> --hosted --image-mode
  --engine claude --engine codex` installs into `BASE=/var/lib/mycel` on the OS disk, then `customize.sh` moves that tree
  to `/usr/lib/mycel/seed-base` (owners kept) and leaves `/var/lib/mycel` an **empty mount point**. The kit stays in
  `/usr/lib/mycel/kit`. At first boot `mycel-enroll` formats the data disk (ext4, label `axdata`), mounts it at BASE and
  copies the seed onto it, so app versions and root binaries live on the data disk and survive a reimage.
- `var-lib-mycel.mount` (What=`/dev/disk/by-label/axdata`) — **not enabled**: at first boot the disk is blank and an
  enabled mount would hold `multi-user.target` for the device timeout. The mycel units pull it in instead through
  drop-ins `mycel-{server,launcher,firewall,update}.service.d/10-ax-data.conf` (`RequiresMountsFor=/var/lib/mycel`), so
  no service ever runs on the empty OS-disk directory. `mycel-enroll` starts the mount itself.
- `90-axdata-resize.rules`: on a block `change` uevent of the `axdata` filesystem, `resize2fs` online (resizeTenant).
- `axdata-grow.service` (enabled, `WantedBy=var-lib-mycel.mount`): `resize2fs` each time the data disk is mounted. EC2
  grows a volume while the instance is stopped, and the bigger disk shows up at boot as an `add` event, which the udev
  rule does not see.
- `mycel-link` at `/usr/local/sbin/mycel-link` + `mycel-link.service` (enabled, `ConditionPathExists=/etc/ax/link.json`):
  the ax-link agent, the guest channel on EC2 and Oracle (trina-cloud `docs/research/ec2-per-team.md` §6). On Proxmox
  there is no `link.json`, so it stays inactive and the qemu guest agent is the channel. `--link-bin` of `customize.sh`;
  without it the image works on Proxmox only. Source: `native/cmd/mycel-link` (its `main.go` describes the protocol).
  Files in the guest: `/etc/ax/link.json` (cloud-init; the agent removes the one-time `token` after its register),
  `/var/lib/ax-link/key` (the agent's Ed25519 key, root 0600; on the root disk, so a reimage makes a new one) and
  `/run/ax-link/*.result.json` (results that hostd has not taken yet; tmpfs, sent again after an agent restart).
- `mycel-enroll` at `/usr/local/sbin/mycel-enroll` + `mycel-enroll.service` (oneshot, `ConditionPathExists=/run/ax/enroll.json`,
  no `[Install]`: cloud-init `runcmd` starts it).
- Kit units (`mycel-firewall.timer`, `mycel-launcher`, `mycel-server`, `mycel-update.timer`) are **disabled** in the
  template (enforced after the installer); `mycel-enroll` enables them after the data disk is mounted.
- `/etc/sysctl.d/99-ax-guest.conf`: `kernel.yama.ptrace_scope=2`, `kernel.unprivileged_bpf_disabled=1`,
  `kernel.kptr_restrict=2`, `kernel.dmesg_restrict=1`. Named `99-` so it wins over the kit's `60-mycel.conf`
  (`ptrace_scope = 1` for self-host). Unprivileged user namespaces stay on (bwrap).
- zram (`ram / 2`, zstd), chrony with only the platform sources (`server 10.200.0.1 iburst` for
  Proxmox, `server 169.254.169.123 iburst` = Amazon Time Sync for EC2), journald `SystemMaxUse=200M`, system time zone
  `Etc/UTC` (the team zone is `MYCEL_TEAM_TZ`), `fstrim.timer`, serial getty on ttyS0, root locked.
- unattended-upgrades: **Debian-Security only** (`#clear` of the default origins), no automatic reboot (the kit's
  maintenance timer reboots in the team's window); needrestart restarts services automatically.
- cloud-init `99-ax.cfg`: `datasource_list: [ NoCloud, Ec2, Oracle, None ]` (ds-identify picks Ec2 or
  Oracle only on that platform; Proxmox gives the NoCloud drive), no users, no SSH keys, modules limited to what the
  first boot needs (`write_files`, `growpart`, `resizefs`, hostname, `runcmd`). `mycel-enroll` writes
  `/etc/cloud/cloud-init.disabled` after enrolling.
- The dev environment on srt, image part (EC2 images: `build-ami.sh` stages `scripts/dev-env/srt` as `dev-env-srt/`;
  `customize.sh --srt`): `install-srt.sh --image-mode` checks its packages (the list's groups core, media, fonts and
  devenv: bubblewrap, socat, ripgrep, polkitd, jq, python3, ffmpeg, chromium, build tools, CJK fonts; the kit's installer
  put them there), installs node 22 in `/opt/trina/node`, srt in `/opt/trina/srt/<version>` (both the list's `srt`
  group) and `/opt/trina/devenv/run-wrap`. A copy of the scripts, with `system/` (the list), stays in
  `/usr/lib/mycel/dev-env/srt`. It does **not** turn
  the dev environment on: no polkit rule, no devenv slice, no server drop-in. `install-srt.sh` without `--image-mode` on
  the team server does that (it needs `<base>/root/dev-env.json` on a hosted VM) and then downloads nothing.
- With srt, also `mycel-devenv-boot` (`/usr/local/sbin`), `mycel-devenv-boot.service`, `mycel-devenv-plan.path` and the
  server drop-in `20-devenv-boot.conf`. On a hosted server, at each server start and when `plan.json` changes, it writes
  `dev-env.json` from the plan and runs `install-srt.sh --boot`. The team admin still turns the dev environment on.
  Mapping, risks and roll back: `docs/research/srt-hosted-boot.md`.
- `/etc/ax-template.json` (template version, kit version, `srt` present|none, `production`),
  `/usr/lib/mycel/image-packages.txt`.
- Cleanup: apt lists, ssh host keys, machine-id (empty → regenerated per clone), cloud-init state, logs.

## The kit contract (W1, `scripts/install-linux.sh`, being written on feat/cloud-linux-native)

The template build codes against linux-runtime.md §3.5.1 plus one flag defined by isolation.md §5.2:

- `install-linux.sh install --from <kit dir> --hosted --image-mode --engine claude --engine codex`
- `--image-mode` = do every install step **except**: enabling/starting units, generating a setup code, loading the
  firewall, waiting for health. It must run in a chroot without a running systemd (virt-customize) and must accept
  existing `axserver`/`axagent` accounts (it only checks them, §3.1.2).
- The kit folder has `install-linux.sh` and `VERSION` at its top (§3.6.1 `<out>/install-linux.sh VERSION …`).

Without a kit, `build.sh`/`customize.sh` stop with a message naming this contract. `--allow-missing-kit` builds a
pipeline dry-run image (`production:false`, version `0.0.0-kitless-d13-<date>`) that must never be installed as a
template.

## Build

Needs Linux on the **same architecture** as the image (virt-customize runs the image's binaries), libguestfs and
network; `/dev/kvm` makes it fast (TCG works). Debian/Ubuntu runner or the Proxmox host itself:

```sh
apt-get install -y libguestfs-tools qemu-utils curl openssl file
bash native/build.sh                                  # ARCHS=amd64 on a Mac; produces native/bin/linux-amd64/mycel-enroll
scripts/image/build.sh --arch amd64 \
  --kit dist/TeamAX-server-0.3.0-linux-amd64.tar.gz \
  --enroll-bin native/bin/linux-amd64/mycel-enroll \
  --sign-key /secure/release-ed25519.pem              # optional: PKCS#8 PEM (openssl genpkey -algorithm ed25519)
```

Output in `dist/image/`:

```
teamax-0.3.0-debian13-amd64.qcow2          template version 0.3.0-d13-<yyyymmdd>, Proxmox name tmpl-ax-0.3.0-d13-<yyyymmdd>
teamax-0.3.0-debian13-amd64.qcow2.sha256
teamax-0.3.0-debian13-amd64.qcow2.sig      base64 Ed25519 over "ax-template-v1\n<templateVersion>\n<sha256 hex>"
teamax-0.3.0-debian13-amd64.json           manifest: versions, sha256, sizes, signature info, base image sha512, packages
```

Tried locally (arm64 container on colima, TCG): base download + SHA512 check and `virt-resize` work; `virt-customize
--network` did not start there (passt fails inside containers; without passt the TCG appliance did not launch, and on
aarch64 libguestfs asks for `gic-version=host`, which needs KVM). Run the build on a real Linux host or VM with KVM.

The base image is `https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-<arch>.qcow2`, checked
against that folder's `SHA512SUMS` (pin a dated folder with `--base-url` for a reproducible rebuild). The OS disk is
12 GiB (`virt-resize --expand /dev/sda1`).

If the template's kernel lacks something the smoke test needs (R10), switch the base to `debian-13-generic` (full
kernel) with `--base-url` and the file name — the rest is the same.

## Signing and installTemplate

`installTemplate {templateVersion, url, sha256, sig}` (ee/cloud/contracts/substrate.ts): ax-hostd downloads `url`,
checks `sha256`, verifies `sig` (base64 Ed25519) over the exact bytes

```
ax-template-v1\n<templateVersion>\n<sha256 hex>        (no trailing newline)
```

with the release public key pinned in its config (raw 32-byte key, base64; the manifest's `signature.publicKey`), then
creates the VM 90xx with the §5.3 settings below and converts it to a template. Binding the version into the message
stops a valid image from being installed under another version name. Verified cross-tool: an `openssl pkeyutl -rawin`
signature checks with `verifyText` from `ee/cloud/contracts/canonical.ts`.

## Import by hand on Proxmox (§5.3)

```sh
scripts/image/pve-import.sh --image /var/lib/vz/import/teamax-0.3.0-debian13-amd64.qcow2 \
  --version 0.3.0-d13-20261022 [--vmid 9000] [--storage ax-vm] \
  [--sig teamax-0.3.0-debian13-amd64.qcow2.sig --pubkey release-pub.pem] [--dry-run]
```

It runs (idempotent: an existing `tmpl-ax-<version>` template is reported, not redone):

```sh
qm create 9000 --name tmpl-ax-<v> --tags 'ax;template' --machine q35 --bios seabios --ostype l26 --cpu x86-64-v3 \
  --cores 4 --sockets 1 --numa 0 --memory 2048 --balloon 2048 --allow-ksm 0 --hotplug disk,network,cpu \
  --scsihw virtio-scsi-single --scsi0 ax-vm:0,import-from=<abs path>,discard=on,iothread=1,ssd=1 --boot order=scsi0 \
  --serial0 socket --vga serial0 --tablet 0 --rng0 source=/dev/urandom,max_bytes=1024,period=1000 \
  --agent enabled=1,freeze-fs-on-backup=1,fstrim_cloned_disks=1 --onboot 0
qm template 9000
qm set 9000 --protection 1
```

No USB, audio, display or PCI devices (QEMU attack surface). Tenants get memory, vcpus, NIC, the data disk and the
cloud-init drive when ax-hostd clones them (isolation §6.2 createTenant).

## Smoke test (H-05 done-when)

Boot a throw-away VM from the template on the Proxmox host (a linked clone; no NIC, data disk or enroll needed for
the template checks), copy the test in through the guest agent and run it:

```sh
N=$(hostname)
qm clone 9000 990 --name ax-smoke --full 0 && qm set 990 --protection 0
qm start 990 && until qm agent 990 ping 2>/dev/null; do sleep 2; done
pvesh create /nodes/$N/qemu/990/agent/file-write --file /root/vm-smoke.sh --content "$(cat tests/linux/vm-smoke.sh)"
qm guest exec 990 --timeout 180 -- bash /root/vm-smoke.sh      # prints PASS/FAIL/SKIP lines in out-data; exitcode 0 = pass
qm stop 990 && qm destroy 990 --purge
```

After a real `createTenant` the same script also checks the enrolled state (data disk mounted at BASE, kit on it).

`vm-smoke.sh` checks: accounts 980/981 locked with nologin, `unshare -Ur true` and `bwrap --unshare-all` as an
unprivileged user, `nft -f` with `meta skuid "axagent"`, `mycel-launcher --dedicated-account` running as uid 981,
the launcher's `tcp-peer` probe naming the engine-account process, the four sysctls, no sshd (binary, units, `:22`
listener), guest agent / chrony / zram / fstrim, chrony only `10.200.0.1`, UTC, the cloud-init lock, the first-boot
units, the data-disk mount point and seed (before enroll) or the kit on the data disk (after enroll). The W1 engine
lockdown test (pinned engine versions, real engine) is a separate suite (linux-runtime.md §3.9) and is reported SKIP.

## Local check on a Mac (no KVM)

```sh
bash scripts/image/test-customize.sh                       # native arch of the Docker VM (arm64 on Apple silicon)
bash scripts/image/test-customize.sh --platform linux/amd64  # amd64 under emulation (slower)
```

It builds a fake kit (honours only `--image-mode`), the real Linux `mycel-launcher`, runs `customize.sh` twice (the
second run must report `changed=0`), checks the seed move and an empty BASE, runs `vm-smoke.sh --container`, and two
negatives (no kit → refused with the contract message; an `sshd` binary → smoke FAIL). In a container on an Ubuntu
host kernel (colima) the unprivileged-userns checks are SKIP: that restriction is the host's
(`apparmor_restrict_unprivileged_userns=1`), the Debian template kernel has none.

## EC2 image (AMI)

The EC2 plan (trina-cloud `docs/research/ec2-per-team.md`) runs each team on its own EC2 instance. The team image is
then an AMI, not a qcow2. `build-ami.sh` makes it from the official Debian 13 AMI with the same `customize.sh`, so the
two images have the same content. It runs on a Mac or Linux with the owner's AWS CLI session (no IAM role) and keeps
nothing in AWS except the AMI and its root snapshot.

Inputs, all for **linux amd64** (t3a is x86-64; on an Apple silicon Mac cross-compile):

```sh
ARCHS=amd64 bash native/build.sh                     # native/bin/linux-amd64/mycel-enroll and mycel-link
scripts/image/build-ami.sh \
  --profile <trina profile> --account <trina account id> \
  --kit dist/TeamAX-server-0.3.0-linux-amd64.tar.gz \
  --enroll-bin native/bin/linux-amd64/mycel-enroll \
  --link-bin native/bin/linux-amd64/mycel-link \
  --subnet-id subnet-…                                 # internet access + a NACL that lets SSH in (not a team subnet)
  --sign-key /secure/release-ed25519.pem               # the same release key as for the qcow2
```

`--account` is required (except with `--dry-run`, also for `--cleanup`): the build stops before any change when the AWS
session is another account. The default AWS CLI profile of a machine can belong to another company.

Steps (each id goes into `dist/image/ami-build-<templateVersion>.state` before the next call):

1. A temporary security group (tcp 22 from your address only) and a t3a.medium builder from the Debian AMI (checked
   against Debian's owner id 136693071363). The SSH host key and login key are made on your machine and sent in
   user-data, so the first SSH login checks a known host key. IMDSv2 only.
2. A 20 GiB gp3 encrypted work volume from the Debian AMI's root snapshot, attached to the builder only after its
   first SSH login (the volume has the same UUIDs as the builder's root, so it must not be there at boot).
3. `ami-chroot.sh` on the builder: finds the volume by its EBS serial (`/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol…`;
   the attach name and the file system UUID do not help on NVMe), grows partition 1 and its file system, mounts it,
   binds `/dev /dev/pts /proc /sys /run`, puts the builder's `resolv.conf` in for the build, runs `customize.sh` in a
   chroot, puts the image's own `resolv.conf` back and checks that `/var/lib/cloud`, the machine id and the SSH host
   keys are empty. A new instance then runs cloud-init as a first boot.
4. Detach, snapshot (waits for `completed`), RegisterImage: `x86_64`, ENA, `uefi-preferred`, IMDSv2 (`v2.0`), root
   `/dev/xvda`, gp3, 20 GiB.
5. Terminate the builder, delete the work volume and the security group.
6. `teamax-<templateVersion>.ami.json` is written once, then hashed (`.sha256`) and signed (`.sig`):

```json
{"v":1,"kind":"ami","templateVersion":"0.3.0-d13-20261105","region":"ap-northeast-2","imageId":"ami-…","rootSnapshotId":"snap-…","architecture":"x86_64","sourceImageId":"ami-…","kitVersion":"0.3.0","builtAt":"2026-11-05T…Z"}
```

The signature is the one of "Signing and installTemplate" above, over the sha256 of the manifest file:
`ax-template-v1\n<templateVersion>\n<sha256 of teamax-<templateVersion>.ami.json>`. Upload the manifest and its `.sig`
where the qcow2 goes. The CP's `installTemplate` sends `url`, `sha256` and `sig` as for the qcow2; ax-hostd (EC2 driver)
checks the signature, then checks that the AMI exists in its region with `ax:template = <templateVersion>` and this root
snapshot.

Tags: builder, its root volume, the work volume and the security group get `ax:managed=ami-build`; the AMI and its
snapshot get `ax:managed=ami` and `ax:template=<templateVersion>`. `--test` adds `trina-test=ec2-driver` and a Name that
starts with `trina-test-` on everything, so a check by that tag finds all of it. `--tag K=V` adds more.

Failure: the script removes what the state file names (builder, work volume, security group, and the snapshot while no
AMI is registered), and only when the resource carries the expected `ax:managed` tag. It never deletes by filter: the
account also holds production. After a hard stop (kill, lost laptop) run `build-ami.sh --cleanup <state file>`.
`--dry-run` prints every aws command and calls none. `--sign-key` with `--allow-missing-kit` is refused. An AMI for the same template version stops the build before any
create call.

Cost of one build: a t3a.medium for about 30 minutes and a 20 GiB volume for the same time (cents), then the AMI
snapshot (20 GiB of which only the used blocks count, about $0.05 per GB-month).

Smoke test on EC2 (after the build): launch one t3a.medium from the AMI with a data volume as `/dev/sdf` and no
user-data or a hand-made one, then run `tests/linux/vm-smoke.sh` in it (it detects EC2: no qemu guest agent check;
`mycel-link` is checked when `/etc/ax/link.json` exists; chrony must select 169.254.169.123). Not checked by any test
yet, so check by hand on the first instance:

- the uids 980/981 are free in the Debian AMI (`customize.sh` stops with `uid N is taken` if not),
- DNS works for the server account: if `resolv.conf` names 169.254.169.253, the kit firewall (`server_out` rejects
  169.254.0.0/16) blocks it, and the firewall rule generator must allow the resolver,
- `resize2fs` after a data volume grow while the instance is stopped (`axdata-grow.service`).

Local test without AWS: `bun test tests/unit/image-build-ami.test.ts` (stub `aws`, `ssh` and `scp` on PATH).

### Several regions: the v2 manifest

`build-ami.sh` builds the AMI in one region and writes a v1 manifest (one `region`, one `imageId`). An ax-hostd that
serves more than one region refuses a v1 manifest ("manifest v1 has one region … needs a v2 manifest"). It needs a v2
manifest with one AMI per AWS region of the host, under one signature. `ami-manifest-v2.sh` (or
`build-ami.sh --manifest-v2 …`, the same script) makes it. It does not build, and it does not touch the v1 manifest:

```json
{"v":2,"kind":"ami","templateVersion":"0.4.0-beta.8-d13-20261105","architecture":"x86_64","images":{"ap-northeast-2":{"imageId":"ami-…","rootSnapshotId":"snap-…"},"ap-southeast-1":{"imageId":"ami-…","rootSnapshotId":"snap-…"}},"kitVersion":"0.4.0-beta.8","builtAt":"2026-11-05T…Z"}
```

- The keys of `images` are **AWS region names** (`ap-southeast-1`), not Trina region ids (`sg-singapore-1`): hostd looks
  up each region by its `awsRegion`. The script refuses a Trina region id.
- File name `teamax-<templateVersion>.v2.ami.json` (+ `.sha256`, `.sig`). It ends in `.ami.json`, because the CP
  (`templateUrlProblem`) and hostd take only such a URL. A v1 file of the same version can stay beside it. Give the v2 URL
  to the install-template form by hand.
- Signature: the same key and the same message as v1, `ax-template-v1\n<templateVersion>\n<sha256 of the v2 file>`.
- A hostd with one region also takes a v2 manifest (it reads only its own region).

Two ways to give the AMIs:

```sh
# 1. the AMIs exist already in every region (copied by hand, or by an earlier run): read-only checks, then the manifest
scripts/image/build-ami.sh --manifest-v2 --profile <trina profile> --account <trina account id> \
  --template-version 0.4.0-beta.8-d13-20261105 \
  --image ap-northeast-2=ami-…:snap-… --image ap-southeast-1=ami-…:snap-… \
  --sign-key /secure/release-ed25519.pem

# 2. copy the AMI of the first --image to more regions, then the manifest for all of them
scripts/image/build-ami.sh --manifest-v2 --profile <trina profile> --account <trina account id> \
  --template-version 0.4.0-beta.8-d13-20261105 \
  --image ap-northeast-2=ami-… --copy-to ap-southeast-1 \
  --sign-key /secure/release-ed25519.pem
```

`:snap-…` is optional: without it the script reads the root snapshot from AWS. With it the script also checks it.

`--copy-to REGION`: `CopyImage --encrypted` (the default EBS key of the target region) with the client token
`ax-<templateVersion>-<region>`, so a second run after a stop makes no second copy. The copy and its snapshot get the
tags of the source AMI (not `aws:*`), and always `ax:managed=ami` and `ax:template=<templateVersion>`, at the copy and
again with CreateTags once the copy is available (it waits up to 90 minutes). When the region has an AMI with
`ax:template=<templateVersion>` already, the script uses that one and copies nothing. A copy asks for confirmation
unless `--yes`.

Before it writes, the script checks every region read-only, as hostd `installTemplate` does: the AMI is ours (owner
self), `available`, `x86_64`, ENA on, `ax:template=<templateVersion>`, `ax:managed=ami`, and its root snapshot is the
expected one. It also checks the snapshot: `completed`, encrypted, `ax:managed=ami`. hostd does not check the snapshot
tag at install, but its IAM policy lets RunInstances and CreateVolume use only a snapshot with that tag, so a missing
tag would fail later, at the first team launch in that region. Any failure: no file is written. `--dry-run` prints the
aws commands and calls none. One v2 file per template version: the script stops when it exists.

Then, as for v1: upload `teamax-<templateVersion>.v2.ami.json`, and install it on the host with its URL, the value in
`.v2.ami.json.sha256` and the contents of `.v2.ami.json.sig`.

Local test without AWS: `bun test tests/unit/image-ami-manifest-v2.test.ts` (stub `aws` on PATH, a throwaway Ed25519
key; the signature is checked with the algorithm of hostd `verifyText`).
