package peer

import (
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

var lsofName = regexp.MustCompile(`^(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)->[^:]+:(\d+)$`)

func tcpOwner(clientPort, serverPort int) (int, error) {
	out, _ := exec.Command("/usr/sbin/lsof", "-nP", fmt.Sprintf("-iTCP:%d", clientPort), "-sTCP:ESTABLISHED", "-Fpn").Output()
	pid := 0
	for _, l := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(l, "p") {
			pid, _ = strconv.Atoi(l[1:])
		} else if strings.HasPrefix(l, "n") {
			if m := lsofName.FindStringSubmatch(l[1:]); m != nil && m[1] == strconv.Itoa(clientPort) && m[2] == strconv.Itoa(serverPort) {
				return pid, nil
			}
		}
	}
	return 0, fmt.Errorf("no process owns 127.0.0.1:%d -> :%d", clientPort, serverPort)
}
