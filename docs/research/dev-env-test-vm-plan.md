# Dev environment: test VM plan (dev-env-test)

Status: PLAN, waiting for approval. Nothing of this was run. Branch `feat/dev-env` (experiment).

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

```bash
git clone -b feat/dev-env https://github.com/trina-app/trina-ax.git && cd trina-ax
apt-get install -y golang-go bc && (cd native && CGO_ENABLED=0 go build -o /tmp/mycel-boxd ./cmd/mycel-boxd)
scripts/dev-env/vm-setup.sh /tmp/mycel-boxd
scripts/dev-env/vm-tests.sh | tee /root/vm-tests.txt
LONG=1 scripts/dev-env/vm-tests.sh | tail -3      # also the idle stop (about 6 minutes)
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
