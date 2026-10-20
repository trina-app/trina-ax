package peer

import (
	"fmt"
	"os"
	"strings"
)

func tcpOwner(clientPort, serverPort int) (int, error) {
	inode := ""
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		for _, l := range strings.Split(string(b), "\n")[1:] {
			c := strings.Fields(l)
			if len(c) < 10 {
				continue
			}
			if strings.HasSuffix(c[1], fmt.Sprintf(":%04X", clientPort)) && strings.HasSuffix(c[2], fmt.Sprintf(":%04X", serverPort)) {
				inode = c[9]
				break
			}
		}
		if inode != "" {
			break
		}
	}
	if inode == "" {
		return 0, fmt.Errorf("connection not found")
	}
	want := "socket:[" + inode + "]"
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		var pid int
		if _, err := fmt.Sscanf(e.Name(), "%d", &pid); err != nil {
			continue
		}
		fds, _ := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
		for _, fd := range fds {
			if l, _ := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", pid, fd.Name())); l == want {
				return pid, nil
			}
		}
	}
	return 0, fmt.Errorf("owner not found")
}
