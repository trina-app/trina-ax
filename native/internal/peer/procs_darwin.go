package peer

import "golang.org/x/sys/unix"

func ownProcs(uid int) ([]Proc, error) {
	ks, err := unix.SysctlKinfoProcSlice("kern.proc.uid", uid)
	if err != nil {
		return nil, err
	}
	out := make([]Proc, 0, len(ks))
	for _, k := range ks {
		pid := int(k.Proc.P_pid)
		sid, _ := unix.Getsid(pid)
		out = append(out, Proc{Pid: pid, Ppid: int(k.Eproc.Ppid), Sid: sid})
	}
	return out, nil
}
