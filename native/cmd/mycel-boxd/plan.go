// mycel-boxd: the box helper of the dev environment EXPERIMENT (docs/DECISIONS.md "Dev environment (experiment)",
// P0 spike docs/research/dev-env-p0-spike.md on branch spike/dev-env-p0). It runs as root, owns every project box
// and is the only program that runs podman (rootless, as the box account; never the server or the engine account).
// The server asks it over boxd.sock (only the server's uid; root gets status only, mycel-ctl update asks that after a
// restart); the AI engine never reaches it.
//
// Protocol: one JSON request line per connection, one JSON answer line (shared/src/dev-env.ts):
//
//	{"op":"status"}                                     -> {"ev":"status","available","reason","checks","boxes"}
//	{"op":"ensure","box","folder","network","limits"}  -> {"ev":"ok","box"}   make + start; rules load or the box stops
//	{"op":"stop"|"destroy","box"}                       -> {"ev":"ok"}
//	{"op":"exec","box","cwd","command","timeoutMs","background","job","logName","actor"} -> {"ev":"exit",...}
//	{"op":"ps","box"}                                   -> {"ev":"ps","processes"}
//	{"op":"preview","box","port"}                       -> {"ev":"preview","socket"}
//	{"op":"jobs","box"}                                 -> {"ev":"jobs","running","jobs"}
//
// A box in status also has stopCode, stopReason and stoppedAt after boxd stopped it by itself. An exec answer also has
// job (the command runs as a tracked job) and reason (with the signal box_stopped). Every new field is optional, so an
// older server ignores it, and a server that gets "unknown op" from an older boxd goes on without jobs.
//
// Disk: diskGiB sizes only the box volume. /work is the team folder on the server's disk, and the team file system has
// no project quota, so one watchdog per running box stops the box when the server disk comes under diskFloor. It runs
// per box and not per exec, because a background command writes after its exec returned. It reads every disk that box
// files go to: the team root, --state-dir (box volumes) and podman's storage. The disk nearest its floor counts.
//
// Jobs: exec with job true starts a background command in a wrapper that writes /cache/logs/<name>.exit. boxd reads that
// file and the log from the box volume directly, because an exec counts as activity. The box writes that volume and
// boxd is root, so each read refuses links and special files and caps the size (volread_linux.go).
//
// A box takes a new image or seccomp profile at its next start. A running box keeps running: a change must not kill a
// running render. The image and profile are read at each ensure, so a rebuild needs no boxd restart. The exception: if
// the image or the profile was missing when boxd started, setup says boxes are not available until boxd starts again.
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
	Job        bool     `json:"job"`
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
	pidsHeadroom = 4
	// a "4 GB" VM reports less than 4096 MiB (3.8 GB on the test server): the kernel keeps some for itself
	minHostMiB = 3584
	pidsWait   = 5 * time.Second

	// the VM test of 2026-11-02 wrote to the team disk with peaks of 500-740 MiB/s, and a 1 s poll went more than 500 MB
	// past the floor. At 100 ms, about 74 MiB goes past the floor before the watchdog sees it.
	diskPoll         = 100 * time.Millisecond
	diskFloorMin     = 2 << 30
	diskFloorPercent = 5
	// a box that starts just over the floor stops again at its first writes
	diskStartMargin = 1 << 30
	// EOPNOTSUPP: the box's answer to fallocate (scripts/dev-env/make-seccomp.py)
	errnoNotSupported = 95

	// CPU share of one core (10%) over the idle check that counts as activity. An idle dev server wakes only for timers
	// and file watches, about 1 to 2% of a core, and up to about 5% with a polling watcher. A render uses all of its limit,
	// and the smallest limit is 0.25 CPU, so a render is over this at every limit. A share of the box's own limit is not
	// used: at 0.25 CPU, 10% of the limit is 2.5% of a core, which an idle dev server can reach.
	cpuBusyShare = 0.10
	// CPU use keeps a box for at most this time after the last command or preview connection: an endless loop also uses CPU
	busyMax = 6 * time.Hour

	maxJobs      = 32
	exitFileMax  = 32
	jobTailRead  = 16 << 10
	jobTailBytes = 4 << 10
	jobTailLines = 40
)

// why boxd stopped a box by itself (status: stopCode). The server tells people about stopDisk and stopBusyMax.
const (
	stopDisk    = "disk"
	stopBusyMax = "busy_max"
	stopIdle    = "idle"
	stopPids    = "pids"
	stopExited  = "exited"
)

// peerMay: the server may send every request. Root may only ask for status.
func peerMay(uid int, op string) bool {
	return uid == *serverUID || uid == 0 && op == "status"
}

// checkRequest validates what every op needs; the folder is checked again on disk (run_linux.go openFolder).
func checkRequest(r *request) error {
	switch r.Op {
	case "status":
		return nil
	case "ensure", "stop", "destroy", "exec", "ps", "preview", "netlog", "jobs":
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
		if r.Job && (!r.Background || r.LogName == "") {
			return fmt.Errorf("a job needs background and a log name")
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

// hostMemoryProblem: why this machine is too small for a box, or "". The default box limit (2.5 GB) leaves the server
// and the engine turns too little on a smaller VM. 0 = not known: the other checks decide.
func hostMemoryProblem(memTotalKiB int64) string {
	mib := memTotalKiB / 1024
	if mib == 0 || mib >= minHostMiB {
		return ""
	}
	return fmt.Sprintf("the dev environment needs a team VM with at least 4 GB of memory; this one has %.1f GB", float64(mib)/1024)
}

// pidsAtLimit: from cgroup pids.current and pids.max. An exec needs a few processes of its own (runtime, timeout, bash).
// False when a value cannot be read: the exec then says what is wrong by itself.
func pidsAtLimit(current, max string) bool {
	c, err1 := strconv.Atoi(strings.TrimSpace(current))
	m, err2 := strconv.Atoi(strings.TrimSpace(max)) // "max" = no limit
	return err1 == nil && err2 == nil && c+pidsHeadroom >= m
}

func containerName(box string) string { return "mycel-box-" + box }

// createArgs: `podman create` for one box (the P0 spike's box.sh create, adjusted: no engine mount at all, no proxy
// sockets; the engine runs outside the box and the model token never enters it). image is the resolved image ID, not
// the name, so the box gets the same image that imgHash names.
func createArgs(box string, p boxPaths, image, seccomp, imgHash string, l limits, network string) []string {
	mem := strconv.Itoa(l.MemoryMiB) + "m"
	net := "pasta:--no-map-gw,--map-guest-addr,none"
	if network == "offline" {
		net = "none"
	}
	args := []string{"create", "--name", containerName(box), "--hostname", "box",
		"--label", "mycel.box=" + box, "--label", "mycel.config=" + configHash(l, network), "--label", "mycel.image=" + imgHash,
		"--network", net,
		"--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=" + tmpSize + ",mode=1777",
		"--cap-drop=ALL", "--security-opt", "no-new-privileges", "--security-opt", "seccomp=" + seccomp,
		"--pids-limit", strconv.Itoa(l.Pids), "--memory", mem, "--memory-swap", mem,
		// No --cpu-shares: libuv 1.50 (Node 20 in the box) multiplies the CPU count by cpu.weight/100, so weight 20
		// gave os.availableParallelism() 1 at any --cpus. The weight also never ranked the box below the team server:
		// the box's scope is in user.slice, the server in mycel.slice.
		"--cpus", strconv.FormatFloat(l.CPUs, 'f', -1, 64),
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

// labelsFormat: the two labels of a box for `podman inspect`, in the order that keepRunning and reuseStopped read.
const labelsFormat = `{{index .Config.Labels "mycel.config"}} {{index .Config.Labels "mycel.image"}}`

// configHash: the label mycel.config, what a running box must match. A change here stops a running box. Change the
// last value when createArgs changes: each box is then made again once.
func configHash(l limits, network string) string {
	b, _ := json.Marshal([]any{l.CPUs, l.MemoryMiB, l.Pids, network, 3})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:8])
}

// imageHash: the label mycel.image, what a box takes at its start: the image ID (a rebuild keeps the name and changes
// the ID) and the seccomp profile's content (podman copies the profile into the container at create).
func imageHash(imageID string, seccomp []byte) string {
	s := sha256.Sum256(seccomp)
	b, _ := json.Marshal([]any{imageID, hex.EncodeToString(s[:])})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:8])
}

// keepRunning: a running box stays when its limits and network match, also when the image or the profile changed.
func keepRunning(labels string, l limits, network string) bool {
	f := strings.Fields(labels)
	return len(f) > 0 && f[0] == configHash(l, network)
}

// reuseStopped: a box that does not run is started as it is only when both labels match. Any other box is made again;
// this includes a box from an older boxd, which has no mycel.image label.
func reuseStopped(labels, imgHash string, l limits, network string) bool {
	f := strings.Fields(labels)
	return len(f) == 2 && f[0] == configHash(l, network) && f[1] == imgHash
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
	return "mkdir -p /cache/logs /cache/run\ncat > /cache/run/" + logName + ".sh <<'" + delim + "' || exit 1\n" + cmd + "\n" + delim + "\n" +
		"setsid nohup /bin/bash -l /cache/run/" + logName + ".sh > /cache/logs/" + logName + ".log 2>&1 < /dev/null &\n" +
		"echo \"started pid $! (log /cache/logs/" + logName + ".log)\"\n"
}

// jobScript: what bash reads on stdin for a job. As a background command, plus a wrapper that writes the exit code. The
// wrapper writes to a temporary name and renames it, so boxd never reads half a file. An exit file from an earlier job
// of this name goes first, or it reads as the end of this job. The temporary file exists before the job starts and the
// wrapper writes into it with no truncate, so a log that filled the box volume does not lose the exit code. On a full
// volume a script that cannot be written does not run: half a script is worse than none.
func jobScript(cmd, name, delim string) string {
	log, exit := "/cache/logs/"+name+".log", "/cache/logs/"+name+".exit"
	return "mkdir -p /cache/logs /cache/run\ncat > /cache/run/" + name + ".sh <<'" + delim + "' || exit 1\n" + cmd + "\n" + delim + "\n" +
		"rm -f " + exit + " " + exit + ".tmp\n" +
		"printf '   \\n' > " + exit + ".tmp || exit 1\n" +
		"setsid nohup /bin/bash -c '/bin/bash -l /cache/run/" + name + ".sh; printf \"%3d\\n\" $? 1<> " + exit + ".tmp; mv -f " + exit + ".tmp " + exit + "' > " + log + " 2>&1 < /dev/null &\n" +
		"echo \"started pid $! (log " + log + ")\"\n"
}

// fastAllocRefused: does this seccomp profile close the calls that take disk space faster than the watchdog polls
// (make-seccomp.py): fallocate answers EOPNOTSUPP and ioctl has no plain ALLOW (FS_IOC_RESVSP)? An older profile has
// neither. The profile is not in the kit.
func fastAllocRefused(profile []byte) bool {
	var p struct {
		Syscalls []struct {
			Names    []string `json:"names"`
			Action   string   `json:"action"`
			ErrnoRet int      `json:"errnoRet"`
			Args     []any    `json:"args"`
		} `json:"syscalls"`
	}
	if json.Unmarshal(profile, &p) != nil {
		return false
	}
	refused := false
	for _, s := range p.Syscalls {
		for _, n := range s.Names {
			if n == "fallocate" {
				if s.Action != "SCMP_ACT_ERRNO" || s.ErrnoRet != errnoNotSupported {
					return false
				}
				refused = true
			}
			if n == "ioctl" && len(s.Args) == 0 {
				return false
			}
		}
	}
	return refused
}

// diskFloor: the free space under which a box stops, max(2 GiB, 5% of the disk).
func diskFloor(total uint64) uint64 {
	if f := total / 100 * diskFloorPercent; f > diskFloorMin {
		return f
	}
	return diskFloorMin
}

// diskLow: from statfs of the box disks (worstDisk). 0 = not known: the box stays.
func diskLow(free, total uint64) bool { return total > 0 && free < diskFloor(total) }

// disk: free bytes and size of one file system.
type disk struct{ free, total uint64 }

// worstDisk: the disk with the least free space over its floor. A disk of no known size does not count. ok is false if
// no disk counts.
func worstDisk(ds []disk) (w disk, ok bool) {
	for _, d := range ds {
		if d.total == 0 {
			continue
		}
		// free - floor, smallest wins; added on both sides, so no uint underflow
		if !ok || d.free+diskFloor(w.total) < w.free+diskFloor(d.total) {
			w, ok = d, true
		}
	}
	return w, ok
}

const freeSpaceHint = "Free space: empty the trash or delete files. An admin sees the details in Admin > System"

func gib(n uint64) float64 { return float64(n) / (1 << 30) }

// diskStartRefused: why a box must not start now, or "". The margin keeps a box from starting just over the floor.
func diskStartRefused(free, total uint64) string {
	if need := diskFloor(total) + diskStartMargin; total > 0 && free < need {
		return fmt.Sprintf("the server disk has only %.1f GiB free and a box needs %.1f GiB free to start. %s", gib(free), gib(need), freeSpaceHint)
	}
	return ""
}

func diskStopReason(free, total uint64) string {
	return fmt.Sprintf("the server disk has only %.1f GiB free, under the %.1f GiB that it must keep. %s", gib(free), gib(diskFloor(total)), freeSpaceHint)
}

// cpuUsageUsec: usage_usec from a cgroup cpu.stat.
func cpuUsageUsec(stat string) (int64, bool) {
	for _, l := range strings.Split(stat, "\n") {
		if f := strings.Fields(l); len(f) == 2 && f[0] == "usage_usec" {
			n, err := strconv.ParseInt(f[1], 10, 64)
			return n, err == nil
		}
	}
	return 0, false
}

// cpuBusy: did the box use more than cpuBusyShare of one core between two readings of usage_usec? False when the
// counter went back: that is a new cgroup, not a reading of this one.
func cpuBusy(prev, cur int64, elapsed time.Duration) bool {
	if elapsed <= 0 || cur < prev {
		return false
	}
	return float64(cur-prev)/float64(elapsed.Microseconds()) >= cpuBusyShare
}

// idleVerdict: why a running box must stop now, or "". lastActive: the last command or preview connection. lastBusy:
// the last check with CPU use over cpuBusyShare. CPU use counts as activity, so a render survives its idle time and an
// idle dev server does not. It counts only for busyMax after the idle time, because an endless loop also uses CPU.
func idleVerdict(now, lastActive, lastBusy time.Time, idle time.Duration) string {
	if idle <= 0 {
		return ""
	}
	last := lastActive
	if lastBusy.After(last) {
		last = lastBusy
	}
	if now.Sub(last) > idle {
		return stopIdle
	}
	if now.Sub(lastActive) > idle+busyMax {
		return stopBusyMax
	}
	return ""
}

// stopKnown: this start of the box already has a reason for its stop.
func stopKnown(code string, stoppedAt, startedAt time.Time) bool {
	return code != "" && !stoppedAt.Before(startedAt)
}

func idleReason(idle time.Duration) string {
	return fmt.Sprintf("the box stopped after %d minutes with no activity", int(idle/time.Minute))
}

func busyMaxReason() string {
	return fmt.Sprintf("the box stopped because it used CPU for %d hours with no command (this limit stops an endless loop)", int(busyMax/time.Hour))
}

// job: one tracked background command of a box. tag: the MYCEL_EXEC value of its processes (while one lives, it runs).
type job struct {
	name, tag string
	started   time.Time
	ended     time.Time
	code      *int
	tail      string
	why       string
}

// jobInfo: one job in the "jobs" answer. code: null while it runs, and when no exit code is known.
type jobInfo struct {
	Name     string `json:"name"`
	State    string `json:"state"`
	Code     *int   `json:"code"`
	Seconds  int64  `json:"seconds"`
	Tail     string `json:"tail"`
	LastLine string `json:"lastLine"`
	Why      string `json:"why,omitempty"`
}

func (j *job) info(now time.Time) jobInfo {
	state, end := "running", now
	if !j.ended.IsZero() {
		state, end = "ended", j.ended
	}
	return jobInfo{Name: j.name, State: state, Code: j.code, Seconds: int64(end.Sub(j.started) / time.Second), Tail: j.tail, LastLine: lastLine(j.tail), Why: j.why}
}

// parseExit: the content of an exit file. The box writes this file, so only a plain number from 0 to 255 counts.
func parseExit(b []byte) (int, bool) {
	s := strings.TrimSpace(string(b))
	if len(s) == 0 || len(s) > 3 {
		return 0, false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, _ := strconv.Atoi(s)
	return n, n <= 255
}

// jobEnded: from what boxd read, in this order: is a process of the job alive, then the exit file. In the other order a
// job that ends between the two reads shows no exit code. An exit file ends a job, also when a process it left runs on.
// With no exit file and no process, something killed the wrapper: the job ended and no exit code is known.
func jobEnded(alive, exitFound bool, exit []byte) (ended bool, code *int) {
	if exitFound {
		if n, ok := parseExit(exit); ok {
			return true, &n
		}
		return true, nil
	}
	return !alive, nil
}

var ansiRe = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")

// tailText: the end of a log as text a person can read: lines from \r too (ffmpeg writes its progress with \r), no
// escape codes or other control bytes, valid UTF-8, at most max bytes and jobTailLines lines. cut: the bytes start
// inside the file, so the first line may be a part of a line. A cut by size also drops the part of a line: the server
// hides stored secrets by whole value, so a piece of a value must not reach it. Only one line longer than max stays in part.
func tailText(b []byte, max int, cut bool) string {
	s := strings.ToValidUTF8(string(b), "")
	s = ansiRe.ReplaceAllString(s, "")
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
	s = strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\n' && r != '\t' || r == 0x7f {
			return -1
		}
		return r
	}, s)
	s = strings.TrimRight(s, " \t\n")
	if cut {
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
	}
	lines := strings.Split(s, "\n")
	if len(lines) > jobTailLines {
		lines = lines[len(lines)-jobTailLines:]
	}
	s = strings.Join(lines, "\n")
	if len(s) > max {
		s = s[len(s)-max:]
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
		for len(s) > 0 && !utf8.RuneStart(s[0]) {
			s = s[1:]
		}
	}
	return s
}

// lastLine: the last line with text of a tail, the progress line of a running job. The whole line: the server shortens it
// after it hides stored secrets.
func lastLine(tail string) string {
	ls := strings.Split(tail, "\n")
	for i := len(ls) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(ls[i]); l != "" {
			return l
		}
	}
	return ""
}

// evictJobs: make room for one more job. The oldest ended jobs go first, and a job that runs stays. False: all maxJobs
// run. An old result goes only when the server had time to read it (it polls every few seconds).
func evictJobs(m map[string]*job) bool {
	for len(m) >= maxJobs {
		var old *job
		for _, j := range m {
			if !j.ended.IsZero() && (old == nil || j.ended.Before(old.ended)) {
				old = j
			}
		}
		if old == nil {
			return false
		}
		delete(m, old.name)
	}
	return true
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
