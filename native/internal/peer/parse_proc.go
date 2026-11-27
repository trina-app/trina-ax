package peer

import (
	"fmt"
	"strconv"
	"strings"
)

// parseStat extracts the parent PID and session ID from a Linux /proc/<pid>/stat line.
func parseStat(line string) (ppid, sid int, ok bool) {
	idx := strings.LastIndex(line, ")")
	if idx < 0 || idx+2 > len(line) {
		return 0, 0, false
	}
	f := strings.Fields(line[idx+2:])
	if len(f) < 4 {
		return 0, 0, false
	}
	ppid, err := strconv.Atoi(f[1])
	if err != nil {
		return 0, 0, false
	}
	sid, err = strconv.Atoi(f[3])
	if err != nil {
		return 0, 0, false
	}
	return ppid, sid, true
}

// findInode looks up the socket inode for a matching clientPort -> serverPort entry
// in a Linux /proc/net/tcp or /proc/net/tcp6 table.
func findInode(table string, clientPort, serverPort int) (string, bool) {
	lines := strings.Split(table, "\n")
	if len(lines) < 2 {
		return "", false
	}
	clientSuffix := fmt.Sprintf(":%04X", clientPort)
	serverSuffix := fmt.Sprintf(":%04X", serverPort)
	for _, l := range lines[1:] {
		c := strings.Fields(l)
		if len(c) < 10 {
			continue
		}
		if strings.HasSuffix(c[1], clientSuffix) && strings.HasSuffix(c[2], serverSuffix) {
			return c[9], true
		}
	}
	return "", false
}
