#!/usr/bin/python3 -I
# Box seccomp profile = podman's default profile (containers-common) + the engine filter's denies
# (native/internal/seccomp/table_linux.go) that a dev box does not need. Differences from the engine filter:
#   - listen() is allowed (dev servers listen)
#   - socket families: unix, inet, inet6, netlink (all netlink protocols: `ip`, glibc need them)
#   - namespace clone flags, unshare, setns, mount: denied as in the engine filter (podman's default already denies
#     them without CAP_SYS_ADMIN; here they are denied even if a capability comes back by mistake)
# Usage: make-seccomp.py /usr/share/containers/seccomp.json > box-seccomp.json
import json, sys

DENY = """unshare setns mount umount2 pivot_root chroot move_mount open_tree open_tree_attr fsopen fsconfig fsmount
fspick mount_setattr ptrace process_vm_readv process_vm_writev kcmp pidfd_getfd perf_event_open bpf userfaultfd
io_uring_setup io_uring_enter io_uring_register keyctl add_key request_key init_module finit_module delete_module
kexec_load kexec_file_load reboot swapon swapoff syslog acct quotactl quotactl_fd settimeofday clock_settime
clock_adjtime adjtimex open_by_handle_at name_to_handle_at fanotify_init vhangup lookup_dcookie nfsservctl""".split()
CLONE_NS = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000
FAMILIES = [1, 2, 10, 16]  # AF_UNIX AF_INET AF_INET6 AF_NETLINK

p = json.load(open(sys.argv[1]))
deny = set(DENY) | {"socket", "clone", "clone3"}
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
] + [{"names": ["socket"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": f, "op": "SCMP_CMP_EQ"}]}
     for f in FAMILIES]
json.dump(p, sys.stdout, indent=1)
