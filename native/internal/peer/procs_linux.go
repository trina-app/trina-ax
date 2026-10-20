package peer

import (
	"fmt"
	"os"
	"strings"
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
		s := string(b)
		f := strings.Fields(s[strings.LastIndex(s, ")")+2:])
		var ppid, sid int
		fmt.Sscanf(f[1], "%d", &ppid)
		fmt.Sscanf(f[3], "%d", &sid)
		out = append(out, Proc{Pid: pid, Ppid: ppid, Sid: sid})
	}
	return out, nil
}
