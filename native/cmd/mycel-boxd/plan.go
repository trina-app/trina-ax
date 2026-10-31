// mycel-boxd: the box helper of the dev environment EXPERIMENT (docs/DECISIONS.md "Dev environment (experiment)",
// P0 spike docs/research/dev-env-p0-spike.md on branch spike/dev-env-p0). It runs as root, owns every project box
// and is the only program that runs podman (rootless, as the box account; never the server or the engine account).
// The server asks it over boxd.sock (only the server's uid may connect); the AI engine never reaches it.
//
// Protocol: one JSON request line per connection, one JSON answer line (shared/src/dev-env.ts):
//
//	{"op":"status"}                                     -> {"ev":"status","available","reason","checks","boxes"}
//	{"op":"ensure","box","folder","network","limits"}  -> {"ev":"ok","box"}   make + start; rules load or the box stops
//	{"op":"stop"|"destroy","box"}                       -> {"ev":"ok"}
//	{"op":"exec","box","cwd","command","timeoutMs","background","logName","actor"} -> {"ev":"exit",...}
//	{"op":"ps","box"}                                   -> {"ev":"ps","processes"}
//	{"op":"preview","box","port"}                       -> {"ev":"preview","socket"}
//
// This file holds the parts without side effects (checks, podman arguments, network rules), so they are tested on
// every OS; run_linux.go does the work.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var boxIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var logNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

type limits struct {
	CPUs        float64 `json:"cpus"`
	MemoryMiB   int     `json:"memoryMiB"`
	Pids        int     `json:"pids"`
	DiskGiB     int     `json:"diskGiB"`
	IdleStopMin int     `json:"idleStopMin"`
}

type request struct {
	Op         string   `json:"op"`
	Box        string   `json:"box"`
	Folder     string   `json:"folder"`
	Network    string   `json:"network"`
	Limits     limits   `json:"limits"`
	DenyAddrs  []string `json:"denyAddrs"`
	Cwd        string   `json:"cwd"`
	Command    string   `json:"command"`
	TimeoutMs  int64    `json:"timeoutMs"`
	Background bool     `json:"background"`
	LogName    string   `json:"logName"`
	Actor      string   `json:"actor"`
	Port       int      `json:"port"`
}

const (
	maxCommand   = 64 << 10
	maxTimeout   = 30 * time.Minute
	outMax       = 64 << 10
	tmpSize      = "256m"
	stopGrace    = 5
	killGraceSec = 5
)

// checkRequest validates what every op needs; the folder is checked again on disk (run_linux.go openFolder).
func checkRequest(r *request) error {
	switch r.Op {
	case "status":
		return nil
	case "ensure", "stop", "destroy", "exec", "ps", "preview", "netlog":
	default:
		return fmt.Errorf("unknown op")
	}
	if !boxIDRe.MatchString(r.Box) {
		return fmt.Errorf("bad box id")
	}
	switch r.Op {
	case "ensure":
		if _, err := cleanRel(r.Folder); err != nil || r.Folder == "" {
			return fmt.Errorf("bad folder")
		}
		if r.Network != "open" && r.Network != "offline" {
			return fmt.Errorf("network must be open or offline")
		}
		l := r.Limits
		if l.CPUs < 0.25 || l.CPUs > 4 || l.MemoryMiB < 256 || l.MemoryMiB > 8192 || l.Pids < 64 || l.Pids > 4096 || l.DiskGiB < 1 || l.DiskGiB > 32 || l.IdleStopMin < 5 || l.IdleStopMin > 240 {
			return fmt.Errorf("limits out of range")
		}
		if len(r.DenyAddrs) > 32 {
			return fmt.Errorf("too many deny addresses")
		}
		for _, a := range r.DenyAddrs {
			if _, err := denyElem(a); err != nil {
				return err
			}
		}
	case "exec":
		if len(r.Command) == 0 || len(r.Command) > maxCommand {
			return fmt.Errorf("command must be 1 to %d bytes", maxCommand)
		}
		if strings.ContainsRune(r.Command, 0) {
			return fmt.Errorf("command contains a NUL byte")
		}
		if _, err := cleanRel(r.Cwd); err != nil {
			return fmt.Errorf("bad cwd")
		}
		if r.TimeoutMs <= 0 || time.Duration(r.TimeoutMs)*time.Millisecond > maxTimeout {
			return fmt.Errorf("timeout out of range")
		}
		if r.LogName != "" && !logNameRe.MatchString(r.LogName) {
			return fmt.Errorf("bad log name")
		}
	case "preview":
		if r.Port < 1024 || r.Port > 65535 {
			return fmt.Errorf("port out of range")
		}
	}
	return nil
}

// cleanRel: a relative path without "..", ".", empty or absolute parts ("" = the folder itself).
func cleanRel(p string) (string, error) {
	if p == "" {
		return "", nil
	}
	if strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) || strings.Contains(p, "\\") {
		return "", fmt.Errorf("bad path")
	}
	for _, s := range strings.Split(p, "/") {
		if s == "" || s == "." || s == ".." {
			return "", fmt.Errorf("bad path")
		}
	}
	return p, nil
}

// boxPaths: the host paths of one box, named by box id only (the spike saw the folder name in /proc/self/mountinfo).
type boxPaths struct {
	Dir, Img, Vol, Work, Run string
}

func pathsOf(root, run, box string) boxPaths {
	d := path.Join(root, "boxes", box)
	return boxPaths{Dir: d, Img: path.Join(d, "volume.img"), Vol: path.Join(d, "volume"), Work: path.Join(d, "work"), Run: path.Join(run, "boxes", box)}
}

func containerName(box string) string { return "mycel-box-" + box }

// createArgs: `podman create` for one box (the P0 spike's box.sh create, adjusted: no engine mount at all, no proxy
// sockets; the engine runs outside the box and the model token never enters it).
func createArgs(box string, p boxPaths, image, seccomp string, l limits, network string) []string {
	mem := strconv.Itoa(l.MemoryMiB) + "m"
	net := "pasta:--no-map-gw,--map-guest-addr,none"
	if network == "offline" {
		net = "none"
	}
	args := []string{"create", "--name", containerName(box), "--hostname", "box",
		"--label", "mycel.box=" + box, "--label", "mycel.config=" + configHash(image, seccomp, l, network),
		"--network", net,
		"--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=" + tmpSize + ",mode=1777",
		"--cap-drop=ALL", "--security-opt", "no-new-privileges", "--security-opt", "seccomp=" + seccomp,
		"--pids-limit", strconv.Itoa(l.Pids), "--memory", mem, "--memory-swap", mem,
		"--cpus", strconv.FormatFloat(l.CPUs, 'f', -1, 64), "--cpu-shares", "512", // lower weight than the team server
		"--userns", "keep-id:uid=0,gid=0", "--user", "0:0", "--init",
		"-v", p.Work + ":/work:rw",
		"-v", p.Vol + "/cache:/cache:rw",
		"-v", p.Vol + "/node_modules:/work/node_modules:rw",
		"-v", p.Vol + "/venv:/work/.venv:rw",
		"-e", "HOME=/cache/home", "-e", "npm_config_cache=/cache/npm", "-e", "PIP_CACHE_DIR=/cache/pip",
		"--workdir", "/work",
		image, "sleep", "infinity",
	}
	return args
}

func configHash(image, seccomp string, l limits, network string) string {
	b, _ := json.Marshal([]any{image, seccomp, l.CPUs, l.MemoryMiB, l.Pids, network, 1})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:8])
}

// execArgs: `podman exec` for one command; the command text goes on stdin (never argv: other host accounts can read
// a process's argv). Background: started with setsid/nohup, output to /cache/logs/<name>.log.
func execArgs(box, cwd string, timeout time.Duration) []string {
	w := "/work"
	if cwd != "" {
		w = "/work/" + cwd
	}
	secs := int((timeout + time.Second - 1) / time.Second)
	return []string{"exec", "-i", "-w", w, containerName(box), "/usr/bin/timeout", "-k", strconv.Itoa(killGraceSec), strconv.Itoa(secs), "/bin/bash", "-l", "-s"}
}

// execScript: what bash reads on stdin. delim: a random word (the command cannot end the here-document by accident).
func execScript(cmd string, background bool, logName, delim string) string {
	if !background {
		return cmd + "\n"
	}
	if logName == "" {
		logName = "background"
	}
	return "mkdir -p /cache/logs /cache/run\ncat > /cache/run/" + logName + ".sh <<'" + delim + "'\n" + cmd + "\n" + delim + "\n" +
		"setsid nohup /bin/bash -l /cache/run/" + logName + ".sh > /cache/logs/" + logName + ".log 2>&1 < /dev/null &\n" +
		"echo \"started pid $! (log /cache/logs/" + logName + ".log)\"\n"
}

// denyElem: one address of the team server for the reject sets (IPv4 or IPv6, a single address or a CIDR).
func denyElem(a string) (string, error) {
	a = strings.TrimSpace(a)
	if ip := net.ParseIP(a); ip != nil {
		return ip.String(), nil
	}
	if _, n, err := net.ParseCIDR(a); err == nil {
		return n.String(), nil
	}
	return "", fmt.Errorf("bad deny address %q", a)
}

var private4 = []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
	"192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4"}
var private6 = []string{"::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "fc00::/7", "fe80::/10", "ff00::/8"}

// rules: the nftables rules loaded into the box's network namespace before any command runs (box-open.nft of the
// spike plus the team server's own addresses). offline: drop everything but loopback (the box has no interface but
// lo; the rules are a second wall). Every reject is counted and logged with a prefix (audit of refused destinations).
func rules(network string, deny []string) string {
	var b strings.Builder
	b.WriteString("flush ruleset\ntable inet mycel_box {\n")
	if network == "offline" {
		b.WriteString("  chain output {\n    type filter hook output priority 0; policy drop;\n    oif \"lo\" accept\n  }\n}\n")
		return b.String()
	}
	v4, v6 := append([]string{}, private4...), append([]string{}, private6...)
	for _, a := range deny {
		e, _ := denyElem(a)
		if strings.Contains(e, ":") {
			v6 = append(v6, e)
		} else if e != "" {
			v4 = append(v4, e)
		}
	}
	sort.Strings(v4[len(private4):])
	sort.Strings(v6[len(private6):])
	fmt.Fprintf(&b, "  set private4 {\n    type ipv4_addr; flags interval; auto-merge\n    elements = { %s }\n  }\n", strings.Join(v4, ", "))
	fmt.Fprintf(&b, "  set private6 {\n    type ipv6_addr; flags interval; auto-merge\n    elements = { %s }\n  }\n", strings.Join(v6, ", "))
	b.WriteString(`  chain output {
    type filter hook output priority 0; policy accept;
    oif "lo" accept
    ip daddr 169.254.1.1 meta l4proto { udp, tcp } th dport 53 accept
    ip daddr @private4 counter log prefix "mycel-box-deny " reject with icmp admin-prohibited
    ip6 daddr @private6 counter log prefix "mycel-box-deny " reject with icmpv6 admin-prohibited
    meta l4proto tcp tcp dport { 25, 465, 587 } counter log prefix "mycel-box-deny " reject with tcp reset
    ct state new counter
  }
}
`)
	return b.String()
}

// procInfo: one process of a box for "ps" (seen from the host through the box's cgroup).
type procInfo struct {
	Pid     int    `json:"pid"`
	Seconds int64  `json:"seconds"`
	Command string `json:"command"`
}

// psFilter: the processes a person should know about: not the box's init and sleep, not boxd's own exec helpers.
func psFilter(ps []procInfo) []procInfo {
	out := []procInfo{}
	for _, p := range ps {
		c := p.Command
		if p.Pid == 1 || c == "" || c == "sleep infinity" || strings.HasPrefix(c, "/run/podman-init") || strings.HasPrefix(c, "/usr/bin/timeout -k ") {
			continue
		}
		if len(c) > 300 {
			c = c[:300]
		}
		p.Command = c
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Pid < out[j].Pid })
	return out
}

// nspid: the pid inside the box from /proc/<pid>/status ("NSpid:\t4711\t12" -> 12).
func nspid(status string) int {
	for _, l := range strings.Split(status, "\n") {
		if strings.HasPrefix(l, "NSpid:") {
			f := strings.Fields(l[len("NSpid:"):])
			if len(f) > 0 {
				n, _ := strconv.Atoi(f[len(f)-1])
				return n
			}
		}
	}
	return 0
}

// capBuf keeps the first max bytes written to it and counts the rest (code sandbox D1).
type capBuf struct {
	b       []byte
	max     int
	dropped int64
}

func (c *capBuf) Write(p []byte) (int, error) {
	if room := c.max - len(c.b); room > 0 {
		n := len(p)
		if n > room {
			n = room
		}
		c.b = append(c.b, p[:n]...)
		c.dropped += int64(len(p) - n)
	} else {
		c.dropped += int64(len(p))
	}
	return len(p), nil
}

// text: valid UTF-8 (a character cut at the end is dropped; other bad bytes become U+FFFD in the JSON answer)
func (c *capBuf) text() string {
	b := c.b
	for i := 0; i < 3 && len(b) > 0 && !utf8.Valid(b); i++ {
		b = b[:len(b)-1]
	}
	if !utf8.Valid(b) {
		b = c.b
	}
	return string(b)
}

// connLine: "<unix time> <proto> <dst>[:<dport>]" from one `conntrack -E -o timestamp` line (the first, original
// direction), "" for other lines.
func connLine(l string) string {
	if !strings.Contains(l, "[NEW]") {
		return ""
	}
	f := strings.Fields(l)
	var ts, proto, dst, dport string
	for i, w := range f {
		switch {
		case i == 0 && strings.HasPrefix(w, "["):
			ts = strings.Trim(w, "[]")
			if j := strings.IndexByte(ts, '.'); j > 0 {
				ts = ts[:j]
			}
		case w == "[NEW]" && i+1 < len(f):
			proto = f[i+1]
		case strings.HasPrefix(w, "dst=") && dst == "":
			dst = w[4:]
		case strings.HasPrefix(w, "dport=") && dport == "":
			dport = w[6:]
		}
	}
	if proto == "" || dst == "" {
		return ""
	}
	if dport != "" {
		if strings.Contains(dst, ":") {
			dst = "[" + dst + "]"
		}
		dst += ":" + dport
	}
	return strings.TrimSpace(ts + " " + proto + " " + dst)
}
