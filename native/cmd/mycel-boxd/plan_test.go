package main

import (
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

var okLimits = limits{CPUs: 1, MemoryMiB: 1536, Pids: 512, DiskGiB: 4, IdleStopMin: 30}

func TestCheckRequest(t *testing.T) {
	good := []request{
		{Op: "status"},
		{Op: "ensure", Box: "p1", Folder: "projects/web", Network: "open", Limits: okLimits, DenyAddrs: []string{"203.0.113.7", "2001:db8::/64"}},
		{Op: "exec", Box: "p1", Cwd: "src", Command: "npm test", TimeoutMs: 1000},
		{Op: "exec", Box: "p1", Command: "npm run dev", TimeoutMs: 1000, Background: true, LogName: "dev"},
		{Op: "exec", Box: "p1", Command: "ffmpeg", TimeoutMs: 1000, Background: true, Job: true, LogName: "render"},
		{Op: "preview", Box: "p1", Port: 5173},
		{Op: "jobs", Box: "p1"},
	}
	for _, r := range good {
		if err := checkRequest(&r); err != nil {
			t.Errorf("%+v: %v", r, err)
		}
	}
	bad := []request{
		{Op: "rm"},
		{Op: "ps", Box: "../x"},
		{Op: "ensure", Box: "p1", Folder: "", Network: "open", Limits: okLimits},
		{Op: "ensure", Box: "p1", Folder: "../etc", Network: "open", Limits: okLimits},
		{Op: "ensure", Box: "p1", Folder: "/etc", Network: "open", Limits: okLimits},
		{Op: "ensure", Box: "p1", Folder: "a", Network: "host", Limits: okLimits},
		{Op: "ensure", Box: "p1", Folder: "a", Network: "open", Limits: limits{CPUs: 16, MemoryMiB: 1536, Pids: 512, DiskGiB: 4, IdleStopMin: 30}},
		{Op: "ensure", Box: "p1", Folder: "a", Network: "open", Limits: okLimits, DenyAddrs: []string{"team.example.com"}},
		{Op: "exec", Box: "p1", Command: "", TimeoutMs: 1000},
		{Op: "exec", Box: "p1", Command: "a\x00b", TimeoutMs: 1000},
		{Op: "exec", Box: "p1", Command: "ls", Cwd: "a/../..", TimeoutMs: 1000},
		{Op: "exec", Box: "p1", Command: "ls", TimeoutMs: int64(31 * time.Minute / time.Millisecond)},
		{Op: "exec", Box: "p1", Command: "ls", TimeoutMs: 1000, LogName: "../x"},
		{Op: "preview", Box: "p1", Port: 22},
		{Op: "exec", Box: "p1", Command: "ls", TimeoutMs: 1000, Job: true, LogName: "x"},
		{Op: "exec", Box: "p1", Command: "ls", TimeoutMs: 1000, Background: true, Job: true},
		{Op: "exec", Box: "p1", Command: "ls", TimeoutMs: 1000, Background: true, Job: true, LogName: "../x"},
		{Op: "jobs", Box: "../x"},
	}
	for _, r := range bad {
		if err := checkRequest(&r); err == nil {
			t.Errorf("%+v: accepted", r)
		}
	}
}

func TestCreateArgs(t *testing.T) {
	p := pathsOf("/var/lib/mycel-boxd", "/run/mycel-boxd", "p1")
	a := strings.Join(createArgs("p1", p, "abc123", "/etc/mycel-boxd/box-seccomp.json", "imghash", okLimits, "open"), " ")
	for _, want := range []string{"--cap-drop=ALL", "no-new-privileges", "seccomp=/etc/mycel-boxd/box-seccomp.json", "--read-only",
		"--memory 1536m --memory-swap 1536m", "--pids-limit 512", "--cpus 1", "--network pasta:--no-map-gw,--map-guest-addr,none",
		"--userns keep-id:uid=0,gid=0", "-v /var/lib/mycel-boxd/boxes/p1/work:/work:rw", "/tmp:rw,nosuid,nodev,size=256m",
		"--label mycel.config=" + configHash(okLimits, "open"), "--label mycel.image=imghash", "--workdir /work abc123 sleep infinity"} {
		if !strings.Contains(a, want) {
			t.Errorf("missing %q in %s", want, a)
		}
	}
	// hole 6: no AI engine in the box (no mount of a Claude Code folder, nothing of the model proxy)
	for _, no := range []string{"claude", "model", "/run/trina", "--privileged", "--cap-add"} {
		if strings.Contains(a, no) {
			t.Errorf("%q in %s", no, a)
		}
	}
	// host paths name the box id, never the folder
	if strings.Contains(a, "projects/") {
		t.Error("folder name in a host path")
	}
	off := strings.Join(createArgs("p1", p, "img", "s", "h", okLimits, "offline"), " ")
	if !strings.Contains(off, "--network none") {
		t.Error(off)
	}
}

func TestConfigHash(t *testing.T) {
	base := configHash(okLimits, "open")
	if base != configHash(okLimits, "open") {
		t.Error("the hash is not stable")
	}
	if base == configHash(okLimits, "offline") {
		t.Error("network not in the config hash")
	}
	for _, l := range []limits{{CPUs: 2, MemoryMiB: 1536, Pids: 512}, {CPUs: 1, MemoryMiB: 2048, Pids: 512}, {CPUs: 1, MemoryMiB: 1536, Pids: 256}} {
		if base == configHash(l, "open") {
			t.Errorf("%+v not in the config hash", l)
		}
	}
}

func TestImageHash(t *testing.T) {
	base := imageHash("id1", []byte(`{"a":1}`))
	if base != imageHash("id1", []byte(`{"a":1}`)) {
		t.Error("the hash is not stable")
	}
	// the same tag after a rebuild has a new ID
	if base == imageHash("id2", []byte(`{"a":1}`)) {
		t.Error("image ID not in the image hash")
	}
	// the same path after a change has new content
	if base == imageHash("id1", []byte(`{"a":2}`)) {
		t.Error("profile content not in the image hash")
	}
}

func TestPeerMay(t *testing.T) {
	prev := *serverUID
	*serverUID = 990
	defer func() { *serverUID = prev }()
	if !peerMay(990, "exec") || !peerMay(990, "status") {
		t.Error("the server may send every request")
	}
	if !peerMay(0, "status") {
		t.Error("root may ask for status")
	}
	for _, op := range []string{"ensure", "stop", "destroy", "exec", "ps", "preview", "netlog", "jobs"} {
		if peerMay(0, op) {
			t.Errorf("root may not send %s", op)
		}
	}
	if peerMay(1000, "status") {
		t.Error("another account may not ask")
	}
}

func TestBoxLabels(t *testing.T) {
	cfg := configHash(okLimits, "open")
	img := imageHash("id1", []byte("profile"))
	newImg := imageHash("id2", []byte("profile"))
	cur := cfg + " " + img

	// a running box stays when the image or the profile changed: a change must not kill a running render
	if !keepRunning(cur, okLimits, "open") {
		t.Error("running box with the same limits and network must stay")
	}
	if keepRunning(cur, okLimits, "offline") || keepRunning(cur, limits{CPUs: 2, MemoryMiB: 1536, Pids: 512}, "open") {
		t.Error("running box with other limits or network must stop")
	}
	// a box that does not run takes the new image at its next start
	if !reuseStopped(cur, img, okLimits, "open") {
		t.Error("stopped box with no change must be reused")
	}
	if reuseStopped(cur, newImg, okLimits, "open") {
		t.Error("stopped box with a new image must be made again")
	}
	if reuseStopped(cur, img, okLimits, "offline") {
		t.Error("stopped box with other network must be made again")
	}
	// a box from an older boxd has no mycel.image label and an old mycel.config: it is made again once, without a crash
	for _, old := range []string{"", "1a2b3c4d5e6f7a8b", "1a2b3c4d5e6f7a8b <no value>", cfg, cfg + " <no value>"} {
		if reuseStopped(old, img, okLimits, "open") {
			t.Errorf("labels %q reused", old)
		}
	}
	for _, old := range []string{"", "1a2b3c4d5e6f7a8b", "1a2b3c4d5e6f7a8b <no value>"} {
		if keepRunning(old, okLimits, "open") {
			t.Errorf("labels %q kept", old)
		}
	}
}

func TestExecArgsAndScript(t *testing.T) {
	a := execArgs("p1", "src", 90*time.Second)
	if strings.Join(a, " ") != "exec -i -w /work/src mycel-box-p1 /usr/bin/timeout -k 5 90 /bin/bash -l -s" {
		t.Error(a)
	}
	// the command never goes into argv
	if s := execScript("echo secret-token", false, "", "D"); s != "echo secret-token\n" {
		t.Error(s)
	}
	bg := execScript("npm run dev", true, "dev", "MYCEL_EOF_ab")
	for _, want := range []string{"<<'MYCEL_EOF_ab' || exit 1\nnpm run dev\nMYCEL_EOF_ab\n", "setsid nohup /bin/bash -l /cache/run/dev.sh > /cache/logs/dev.log 2>&1 < /dev/null &"} {
		if !strings.Contains(bg, want) {
			t.Errorf("missing %q in %s", want, bg)
		}
	}
}

func TestRules(t *testing.T) {
	r := rules("open", []string{"203.0.113.7", "2001:db8::1", "198.51.100.0/24"})
	for _, want := range []string{"10.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "fc00::/7", "203.0.113.7", "198.51.100.0/24", "2001:db8::1",
		"tcp dport { 25, 465, 587 }", `ip daddr 169.254.1.1 meta l4proto { udp, tcp } th dport 53 accept`, "flush ruleset"} {
		if !strings.Contains(r, want) {
			t.Errorf("missing %q", want)
		}
	}
	// DNS to pasta's forwarder comes before the private-range reject (169.254.1.1 is link-local)
	if strings.Index(r, "th dport 53 accept") > strings.Index(r, "@private4") {
		t.Error("DNS rule after the reject")
	}
	off := rules("offline", nil)
	if !strings.Contains(off, "policy drop") || strings.Contains(off, "@private4") {
		t.Error(off)
	}
}

func TestPsAndConn(t *testing.T) {
	ps := psFilter([]procInfo{{Pid: 1, Command: "/run/podman-init -- sleep infinity"}, {Pid: 2, Command: "sleep infinity"},
		{Pid: 30, Command: "node /work/node_modules/.bin/vite --host 127.0.0.1"}, {Pid: 9, Command: "/usr/bin/timeout -k 5 120 /bin/bash -l -s"}})
	if len(ps) != 1 || ps[0].Pid != 30 {
		t.Error(ps)
	}
	if nspid("Name:\tnode\nNSpid:\t48211\t30\n") != 30 {
		t.Error("nspid")
	}
	l := connLine("[1730360000.123456]\t    [NEW] tcp      6 120 SYN_SENT src=10.0.2.100 dst=104.16.3.35 sport=40000 dport=443 [UNREPLIED] src=104.16.3.35 dst=10.0.2.100 sport=443 dport=40000")
	if l != "1730360000 tcp 104.16.3.35:443" {
		t.Error(l)
	}
	if connLine("[1] [DESTROY] tcp 6 src=a dst=b") != "" {
		t.Error("destroy line")
	}
	c := &capBuf{max: 4}
	c.Write([]byte("ab한"))
	if c.text() != "ab" || c.dropped != 1 {
		t.Errorf("%q %d", c.text(), c.dropped)
	}
}

func TestPidsAtLimit(t *testing.T) {
	for _, c := range []struct {
		cur, max string
		want     bool
	}{{"512\n", "512\n", true}, {"508", "512", true}, {"507", "512", false}, {"3", "max\n", false}, {"", "512", false}, {"3", "", false}} {
		if pidsAtLimit(c.cur, c.max) != c.want {
			t.Error(c)
		}
	}
}

func TestHostMemoryProblem(t *testing.T) {
	// 3.8 GB is what a 4 GB VM reports
	for _, ok := range []int64{0, 3584 * 1024, 3891 * 1024, 8192 * 1024} {
		if p := hostMemoryProblem(ok); p != "" {
			t.Error(ok, p)
		}
	}
	if p := hostMemoryProblem(2048 * 1024); !strings.Contains(p, "at least 4 GB") || !strings.Contains(p, "2.0 GB") {
		t.Error(p)
	}
}

func TestEntitlement(t *testing.T) {
	const file = `{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}`
	e, err := parseEntitlement([]byte(file))
	if err != nil || e.MaxRunning != 1 || e.MemoryMiB != 2560 || e.Network != "" {
		t.Fatal(e, err)
	}
	for _, bad := range []string{
		`{"format":2,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}`,
		`{"format":1,"plan":"","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}`,
		`{"format":1,"plan":"team","maxRunning":0,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}`,
		`{"format":1,"plan":"team","maxRunning":1,"cpus":8,"memoryMiB":2560,"pids":512,"diskGiB":4}`,
		`{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4,"network":"host"}`,
		`{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4,"gpu":1}`,
		`not json`,
	} {
		if _, err := parseEntitlement([]byte(bad)); err == nil {
			t.Error("accepted", bad)
		}
	}

	ensure := func(l limits, network string) error {
		r := request{Op: "ensure", Box: "p1", Folder: "a", Network: network, Limits: l}
		return checkRequest(&r)
	}
	t.Cleanup(func() { ent = nil })
	ent = nil
	big := limits{CPUs: 4, MemoryMiB: 8192, Pids: 4096, DiskGiB: 32, IdleStopMin: 30}
	if err := ensure(big, "open"); err != nil {
		t.Error("no file: the fixed ranges only", err)
	}
	ent = e
	at := limits{CPUs: 1, MemoryMiB: 2560, Pids: 512, DiskGiB: 4, IdleStopMin: 240}
	if err := ensure(at, "offline"); err != nil {
		t.Error("at the caps", err)
	}
	for _, l := range []limits{
		{CPUs: 1.5, MemoryMiB: 2560, Pids: 512, DiskGiB: 4, IdleStopMin: 30},
		{CPUs: 1, MemoryMiB: 2561, Pids: 512, DiskGiB: 4, IdleStopMin: 30},
		{CPUs: 1, MemoryMiB: 2560, Pids: 513, DiskGiB: 4, IdleStopMin: 30},
		{CPUs: 1, MemoryMiB: 2560, Pids: 512, DiskGiB: 5, IdleStopMin: 30},
	} {
		if err := ensure(l, "offline"); err == nil || !strings.Contains(err.Error(), "over this team's plan") {
			t.Error(l, err)
		}
	}
	if err := ensure(at, "open"); err == nil || !strings.Contains(err.Error(), "network open") {
		t.Error("open without the plan's network", err)
	}
	open := *e
	open.Network = "open"
	ent = &open
	if err := ensure(at, "open"); err != nil {
		t.Error("open in the plan", err)
	}
}

func TestPlanMemoryProblem(t *testing.T) {
	// VM 1000 of the T4 test: 7947 MiB for a 4096 MiB plan and a 2560 MiB box
	if p := planMemoryProblem(7947*1024, 4096, 2560); p != "" {
		t.Error(p)
	}
	// a VM of the plan's size only
	if p := planMemoryProblem(3891*1024, 4096, 2560); !strings.Contains(p, "need 6656 MiB") {
		t.Error(p)
	}
}

func TestJobScript(t *testing.T) {
	s := jobScript("ffmpeg -i a.mp4 b.mp4", "render", "MYCEL_EOF_ab")
	for _, want := range []string{"<<'MYCEL_EOF_ab' || exit 1\nffmpeg -i a.mp4 b.mp4\nMYCEL_EOF_ab\n",
		"rm -f /cache/logs/render.exit /cache/logs/render.exit.tmp\n",
		"printf '   \\n' > /cache/logs/render.exit.tmp || exit 1\n",
		"setsid nohup /bin/bash -c '/bin/bash -l /cache/run/render.sh; printf \"%3d\\n\" $? 1<> /cache/logs/render.exit.tmp; mv -f /cache/logs/render.exit.tmp /cache/logs/render.exit' > /cache/logs/render.log 2>&1 < /dev/null &"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in %s", want, s)
		}
	}
	// the old exit file goes before the new job starts, or it reads as the end of this job
	if strings.Index(s, "rm -f") > strings.Index(s, "setsid") {
		t.Error("exit file removed after the start")
	}
	// the command text stays on stdin, and in the here-document only
	if strings.Count(s, "ffmpeg") != 1 {
		t.Error(s)
	}
}

func TestDiskFloor(t *testing.T) {
	const g = uint64(1) << 30
	for _, c := range []struct{ total, want uint64 }{{10 * g, 2 * g}, {40 * g, 2 * g}, {41 * g, 41 * g / 100 * 5}, {200 * g, 10 * g}, {2000 * g, 100 * g}} {
		if got := diskFloor(c.total); got != c.want {
			t.Errorf("%d: %d, want %d", c.total, got, c.want)
		}
	}
	if diskLow(2*g, 20*g) || !diskLow(2*g-1, 20*g) {
		t.Error("the floor is 2 GiB on a small disk")
	}
	if diskLow(10*g, 200*g) || !diskLow(10*g-1, 200*g) {
		t.Error("the floor is 5% on a large disk")
	}
	if diskLow(0, 0) {
		t.Error("a disk of no known size must not stop a box")
	}
	// the start needs the floor plus a margin
	if why := diskStartRefused(3*g-1, 20*g); !strings.Contains(why, "server disk") || !strings.Contains(why, "Free space") {
		t.Error(why)
	}
	if why := diskStartRefused(3*g, 20*g); why != "" {
		t.Error(why)
	}
	if diskStartRefused(0, 0) != "" {
		t.Error("a disk of no known size must not refuse a box")
	}
	if why := diskStopReason(g, 20*g); !strings.Contains(why, "1.0 GiB free") || !strings.Contains(why, "2.0 GiB") || !strings.Contains(why, "Free space") {
		t.Error(why)
	}
}

func TestCPUUse(t *testing.T) {
	if n, ok := cpuUsageUsec("usage_usec 1234\nuser_usec 1000\nsystem_usec 234\n"); !ok || n != 1234 {
		t.Error(n, ok)
	}
	if _, ok := cpuUsageUsec("nr_periods 0\n"); ok {
		t.Error("no usage_usec")
	}
	if _, ok := cpuUsageUsec(""); ok {
		t.Error("an empty file")
	}
	const m = int64(60_000_000) // one minute of one core, in microseconds
	for _, c := range []struct {
		name string
		used int64
		want bool
	}{
		{"nothing", 0, false},
		{"idle dev server, 2% of a core", m / 50, false},
		{"polling watcher, 5% of a core", m / 20, false},
		{"just under the threshold", m/10 - 1, false},
		{"at the threshold", m / 10, true},
		{"render at the smallest limit, 0.25 CPU", m / 4, true},
		{"render at 1 CPU", m, true},
		{"render at 4 CPUs", 4 * m, true},
	} {
		if got := cpuBusy(5000, 5000+c.used, time.Minute); got != c.want {
			t.Errorf("%s: %v", c.name, got)
		}
	}
	if cpuBusy(100, 50, time.Minute) {
		t.Error("the counter went back: a new cgroup")
	}
	if cpuBusy(0, 100, 0) {
		t.Error("no time between the readings")
	}
}

func TestIdleVerdict(t *testing.T) {
	t0 := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	idle := 30 * time.Minute
	at := func(d time.Duration) time.Time { return t0.Add(d) }
	none := time.Time{}
	for _, c := range []struct {
		name      string
		now, busy time.Time
		idle      time.Duration
		want      string
	}{
		{"just used", at(time.Minute), none, idle, ""},
		{"at the idle time", at(idle), none, idle, ""},
		{"past the idle time, no CPU use", at(idle + time.Second), none, idle, stopIdle},
		{"an idle dev server: CPU use only at the start", at(idle + time.Minute), at(time.Minute), idle, ""},
		{"an idle dev server after the idle time from its last CPU use", at(2*idle + time.Minute), at(time.Minute - time.Second), idle, stopIdle},
		{"a render past the idle time", at(2 * time.Hour), at(2 * time.Hour), idle, ""},
		{"a render ended: the idle time counts from its end", at(2*time.Hour + idle + time.Second), at(2 * time.Hour), idle, stopIdle},
		{"a long render inside the maximum", at(idle + busyMax), at(idle + busyMax), idle, ""},
		{"an endless loop past the maximum", at(idle + busyMax + time.Second), at(idle + busyMax), idle, stopBusyMax},
		{"no idle time set", at(1000 * time.Hour), none, 0, ""},
	} {
		if got := idleVerdict(c.now, t0, c.busy, c.idle); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
	if !strings.Contains(idleReason(idle), "30 minutes") || !strings.Contains(busyMaxReason(), "6 hours") {
		t.Error(idleReason(idle), busyMaxReason())
	}
}

func TestStopKnown(t *testing.T) {
	t0 := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	if stopKnown("", time.Time{}, t0) {
		t.Error("no stop yet")
	}
	if stopKnown(stopDisk, t0.Add(-time.Hour), t0) {
		t.Error("a stop of an earlier start")
	}
	// the disk stop of this start: the idle check that comes after it must not replace it
	if !stopKnown(stopDisk, t0.Add(time.Hour), t0) {
		t.Error("a stop of this start")
	}
}

func TestParseExit(t *testing.T) {
	for in, want := range map[string]int{"0": 0, "0\n": 0, " 137\n": 137, "255": 255} {
		if n, ok := parseExit([]byte(in)); !ok || n != want {
			t.Errorf("%q: %d %v", in, n, ok)
		}
	}
	for _, in := range []string{"", "\n", "256", "-1", "1 2", "abc", "0x10", "1000", "root:x:0:0"} {
		if n, ok := parseExit([]byte(in)); ok {
			t.Errorf("%q: %d", in, n)
		}
	}
}

func TestJobEnded(t *testing.T) {
	check := func(name string, alive, found bool, exit string, ended bool, code int) {
		t.Helper()
		e, c := jobEnded(alive, found, []byte(exit))
		if e != ended {
			t.Errorf("%s: ended %v", name, e)
		}
		if (c == nil) != (code < 0) || (c != nil && *c != code) {
			t.Errorf("%s: code %v", name, c)
		}
	}
	check("runs", true, false, "", false, -1)
	check("ended with a code", false, true, "0\n", true, 0)
	check("failed", false, true, "1\n", true, 1)
	check("ended, and a process it left runs on", true, true, "0\n", true, 0)
	check("wrapper killed: no file, no process", false, false, "", true, -1)
	check("exit file with bad content", false, true, "junk", true, -1)
	check("exit file refused (a link) while it runs", true, false, "", false, -1)
}

func TestTailText(t *testing.T) {
	if s := tailText([]byte("a\nb\n"), 100, false); s != "a\nb" {
		t.Errorf("%q", s)
	}
	// ffmpeg writes its progress with \r
	if s := tailText([]byte("frame=1\rframe=2\rframe=3\r"), 100, false); s != "frame=1\nframe=2\nframe=3" {
		t.Errorf("%q", s)
	}
	if s := tailText([]byte("a\r\nb"), 100, false); s != "a\nb" {
		t.Errorf("%q", s)
	}
	// no escape codes or control bytes reach a person's screen
	if s := tailText([]byte("\x1b[31mred\x1b[0m\x07\x00x\tz"), 100, false); s != "redx\tz" {
		t.Errorf("%q", s)
	}
	// Hangul cut at the start and at the end of the bytes that were read
	raw := []byte("한글 줄")
	if s := tailText(raw[1:len(raw)-1], 100, false); s != "글 " && s != "글" {
		t.Errorf("%q", s)
	}
	// the first line of a cut read is a part of a line; a single long line stays
	if s := tailText([]byte("rt of a line\nwhole\n"), 100, true); s != "whole" {
		t.Errorf("%q", s)
	}
	if s := tailText([]byte("only one long line\n"), 100, true); s != "only one long line" {
		t.Errorf("%q", s)
	}
	// the line cap, and the byte cap that must not split a character
	if s := tailText([]byte(strings.Repeat("x\n", 200)), 1000, false); strings.Count(s, "\n") != jobTailLines-1 {
		t.Error(strings.Count(s, "\n"))
	}
	if s := tailText([]byte(strings.Repeat("글", 2000)), 100, false); len(s) > 100 || !utf8.ValidString(s) || s == "" {
		t.Errorf("%d %q", len(s), s)
	}
	if lastLine("a\nb\n\n  \n") != "b" || lastLine("") != "" {
		t.Error("lastLine")
	}
	// a cut by size starts at a whole line: a piece of a line could be a piece of a stored secret
	if s := tailText([]byte(strings.Repeat("x", 90)+"\nwhole line\n"), 50, false); s != "whole line" {
		t.Error(s)
	}
	// the server shortens this line, after it hides stored secrets
	if l := lastLine(strings.Repeat("글", 400)); l != strings.Repeat("글", 400) {
		t.Error(len(l))
	}
}

func TestEvictJobs(t *testing.T) {
	t0 := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	m := map[string]*job{}
	for i := 0; i < maxJobs; i++ {
		n := "j" + strconv.Itoa(i)
		m[n] = &job{name: n, started: t0}
	}
	if evictJobs(m) {
		t.Error("all jobs run: no room")
	}
	if len(m) != maxJobs {
		t.Error("a running job went")
	}
	m["j1"].ended = t0.Add(time.Hour)
	m["j2"].ended = t0.Add(time.Minute)
	if !evictJobs(m) {
		t.Error("an ended job makes room")
	}
	if m["j2"] != nil || m["j1"] == nil || len(m) != maxJobs-1 {
		t.Error("the oldest ended job must go first")
	}
}

func TestJobInfo(t *testing.T) {
	t0 := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	j := &job{name: "r", started: t0, tail: "a\nframe=9"}
	i := j.info(t0.Add(90 * time.Second))
	if i.State != "running" || i.Seconds != 90 || i.Code != nil || i.LastLine != "frame=9" {
		t.Errorf("%+v", i)
	}
	c := 2
	j.ended, j.code = t0.Add(time.Minute), &c
	i = j.info(t0.Add(time.Hour))
	if i.State != "ended" || i.Seconds != 60 || *i.Code != 2 {
		t.Errorf("%+v", i)
	}
}

func TestFastAllocRefused(t *testing.T) {
	for _, c := range []struct {
		profile string
		want    bool
	}{
		{`{"syscalls":[{"names":["ioctl"],"action":"SCMP_ACT_ALLOW","args":[{"index":1}]},{"names":["fallocate"],"action":"SCMP_ACT_ERRNO","errnoRet":95}]}`, true},
		{`{"syscalls":[{"names":["ioctl"],"action":"SCMP_ACT_ALLOW"},{"names":["fallocate"],"action":"SCMP_ACT_ERRNO","errnoRet":95}]}`, false},
		{`{"syscalls":[{"names":["fallocate","read"],"action":"SCMP_ACT_ALLOW"}]}`, false},
		{`{"syscalls":[{"names":["fallocate"],"action":"SCMP_ACT_ERRNO","errnoRet":1}]}`, false}, // no write() fallback
		{`{"syscalls":[{"names":["fallocate"],"action":"SCMP_ACT_ALLOW"},{"names":["fallocate"],"action":"SCMP_ACT_ERRNO","errnoRet":95}]}`, false},
		{`{"syscalls":[{"names":["read"],"action":"SCMP_ACT_ALLOW"}]}`, false},
		{`not json`, false},
	} {
		if fastAllocRefused([]byte(c.profile)) != c.want {
			t.Error(c.profile)
		}
	}
}
