# Trina AX tenant-template tooling (`scripts/image/`)

Maintainer tooling for a qcow2 tenant template; this source does not promise an official production Docker or VM image download. The template uses Debian 13 "trixie" genericcloud and the Linux kit installed in
image mode + the first-boot pieces (`mycel-enroll`).

| File | What |
|---|---|
| `build.sh` | Builds `teamax-<kitVersion>-debian13-<arch>.qcow2` (+ `.sha256`, `.sig`, manifest `.json`) with libguestfs |
| `customize.sh` | Runs **inside** the image as root (virt-customize). Idempotent: the second run prints `changed=0` |
| `files/` | Units, udev rule, cloud-init lock, sysctl, zram, chrony, journald, unattended-upgrades, needrestart |
| `pve-import.sh` | Manual import on a Proxmox host as template `tmpl-ax-<version>` (what ax-hostd `installTemplate` does) |
| `test-customize.sh` | Local proof without KVM: customize twice in a privileged Debian container + `vm-smoke.sh --container` |
| `../../tests/linux/vm-smoke.sh` | H-05 done-when checks, run inside a VM booted from the template |

## What is in the image

- **Accounts first, fixed ids**: `axserver` uid/gid **990**, `axagent` **991** (system range → the launcher's
  `checkDedicated` accepts the engine account, `native/cmd/mycel-launcher/main.go:65-77`). They are created before any
  package install (systemd-sysusers hands out system ids from 999 down) and are the same in every template version, so
  the files on a tenant's data disk keep their owners when `reimageTenant` swaps the OS disk.
- Packages: `qemu-guest-agent chrony nftables bubblewrap systemd-zram-generator unattended-upgrades needrestart
  ca-certificates e2fsprogs cloud-guest-utils` (+ systemd/udev/tzdata). `openssh-server` purged, `ssh.service`,
  `ssh.socket`, `sshd.service` masked (D15). The kit's own apt step installs its runtime packages.
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
- `mycel-enroll` at `/usr/local/sbin/mycel-enroll` + `mycel-enroll.service` (oneshot, `ConditionPathExists=/run/ax/enroll.json`,
  no `[Install]`: cloud-init `runcmd` starts it).
- Kit units (`mycel-firewall.timer`, `mycel-launcher`, `mycel-server`, `mycel-update.timer`) are **disabled** in the
  template (enforced after the installer); `mycel-enroll` enables them after the data disk is mounted.
- `/etc/sysctl.d/99-ax-guest.conf`: `kernel.yama.ptrace_scope=2`, `kernel.unprivileged_bpf_disabled=1`,
  `kernel.kptr_restrict=2`, `kernel.dmesg_restrict=1`. Named `99-` so it wins over the kit's `60-mycel.conf`
  (`ptrace_scope = 1` for self-host). Unprivileged user namespaces stay on (bwrap).
- zram (`ram / 2`, zstd), chrony with `server 10.200.0.1 iburst` only, journald `SystemMaxUse=200M`, system time zone
  `Etc/UTC` (the team zone is `MYCEL_TEAM_TZ`), `fstrim.timer`, serial getty on ttyS0, root locked.
- unattended-upgrades: **Debian-Security only** (`#clear` of the default origins), no automatic reboot (the kit's
  maintenance timer reboots in the team's window); needrestart restarts services automatically.
- cloud-init `99-ax.cfg`: `datasource_list: [ NoCloud, None ]`, no users, no SSH keys, modules limited to what the
  first boot needs (`write_files`, `growpart`, `resizefs`, hostname, `runcmd`). `mycel-enroll` writes
  `/etc/cloud/cloud-init.disabled` after enrolling.
- `/etc/ax-template.json` (template version, kit version, `production`), `/usr/lib/mycel/image-packages.txt`.
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

`vm-smoke.sh` checks: accounts 990/991 locked with nologin, `unshare -Ur true` and `bwrap --unshare-all` as an
unprivileged user, `nft -f` with `meta skuid "axagent"`, `mycel-launcher --dedicated-account` running as uid 991,
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
