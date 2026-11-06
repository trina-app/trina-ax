#!/usr/bin/python3 -I
# Box seccomp profile = podman's default profile (containers-common) + the engine filter's denies
# (native/internal/seccomp/table_linux.go) that a dev box does not need. Differences from the engine filter:
#   - listen() is allowed (dev servers listen)
#   - socket families: unix, inet, inet6, netlink (all netlink protocols: `ip`, glibc need them)
#   - namespace clone flags, unshare, setns, mount: denied as in the engine filter (podman's default already denies
#     them without CAP_SYS_ADMIN; here they are denied even if a capability comes back by mistake)
#   - fallocate answers EOPNOTSUPP: it takes disk space in much less than the 1 s of boxd's disk watchdog and writes no
#     data, so the floor assumes that a box takes space at disk speed. With this errno glibc posix_fallocate falls back
#     to writes, and other tools go on with write(). EPERM, as in DENY, has no such fallback.
#   - ioctls of type 'X' are refused: FS_IOC_RESVSP, FS_IOC_RESVSP64 and FS_IOC_ZERO_RANGE do what fallocate does. An ERRNO
#     rule next to a plain ALLOW does not work (libseccomp keeps the wider rule), so ioctl is allowed by condition: the
#     type byte (bits 8 to 15 of the request) differs from 'X' in at least one bit. That needs 8 rules, and 255 rules for
#     the other types do not fit the BPF limit. The mask has only these bits, so the upper 32 bits of the register, which
#     the kernel ignores, change nothing. The cost: FS_IOC_FSGETXATTR and the XFS tools do not work in a box.
# Usage: make-seccomp.py /usr/share/containers/seccomp.json > /etc/mycel-boxd/box-seccomp.json (from the P0 spike)
import json, sys

DENY = """unshare setns mount umount2 pivot_root chroot move_mount open_tree open_tree_attr fsopen fsconfig fsmount
fspick mount_setattr ptrace process_vm_readv process_vm_writev kcmp pidfd_getfd perf_event_open bpf userfaultfd
io_uring_setup io_uring_enter io_uring_register keyctl add_key request_key init_module finit_module delete_module
kexec_load kexec_file_load reboot swapon swapoff syslog acct quotactl quotactl_fd settimeofday clock_settime
clock_adjtime adjtimex open_by_handle_at name_to_handle_at fanotify_init vhangup lookup_dcookie nfsservctl""".split()
CLONE_NS = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000
FAMILIES = [1, 2, 10, 16]  # AF_UNIX AF_INET AF_INET6 AF_NETLINK
EOPNOTSUPP = 95  # the same on x86_64 and arm64
IOCTL_TYPE_X = ord("X") << 8

p = json.load(open(sys.argv[1]))
deny = set(DENY) | {"socket", "clone", "clone3", "fallocate", "ioctl"}
for s in p["syscalls"]:
    s["names"] = [n for n in s["names"] if n not in deny]
p["syscalls"] = [s for s in p["syscalls"] if s["names"]]
p["syscalls"] += [
    {"names": DENY, "action": "SCMP_ACT_ERRNO", "errnoRet": 1, "comment": "trina box: engine denies"},
    {"names": ["clone"], "action": "SCMP_ACT_ALLOW",
     "args": [{"index": 0, "value": CLONE_NS, "valueTwo": 0, "op": "SCMP_CMP_MASKED_EQ"}],
     "comment": "trina box: clone without namespace flags"},
    {"names": ["clone3"], "action": "SCMP_ACT_ERRNO", "errnoRet": 38,
     "comment": "trina box: clone3 hides its flags in memory; ENOSYS makes libc fall back to clone"},
    {"names": ["fallocate"], "action": "SCMP_ACT_ERRNO", "errnoRet": EOPNOTSUPP,
     "comment": "trina box: no disk space faster than the disk watchdog; EOPNOTSUPP makes tools fall back to write"},
] + [{"names": ["socket"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": f, "op": "SCMP_CMP_EQ"}]}
     for f in FAMILIES]
p["syscalls"] += [{"names": ["ioctl"], "action": "SCMP_ACT_ALLOW",
                   "args": [{"index": 1, "value": 1 << bit, "valueTwo": ~IOCTL_TYPE_X & (1 << bit), "op": "SCMP_CMP_MASKED_EQ"}],
                   "comment": "trina box: ioctl of any type but 'X' (no space faster than the disk watchdog)"}
                  for bit in range(8, 16)]
json.dump(p, sys.stdout, indent=1)
