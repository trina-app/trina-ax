package peer

import (
	"fmt"
	"os"
	"syscall"
)

func ownProcs(uid int) ([]Proc, error) {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var out []Proc
	for _, e := range ents {
		var pid int
		if _, err := fmt.Sscanf(e.Name(), "%d", &pid); err != nil {
			continue
		}
		var st syscall.Stat_t
		if syscall.Stat("/proc/"+e.Name(), &st) != nil || int(st.Uid) != uid {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		ppid, sid, ok := parseStat(string(b))
		if !ok {
			continue
		}
		out = append(out, Proc{Pid: pid, Ppid: ppid, Sid: sid})
	}
	return out, nil
}
