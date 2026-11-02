package main

import (
	"strings"
	"testing"
	"time"
)

var okLimits = limits{CPUs: 1, MemoryMiB: 1536, Pids: 512, DiskGiB: 4, IdleStopMin: 30}

func TestCheckRequest(t *testing.T) {
	good := []request{
		{Op: "status"},
		{Op: "ensure", Box: "p1", Folder: "projects/web", Network: "open", Limits: okLimits, DenyAddrs: []string{"203.0.113.7", "2001:db8::/64"}},
		{Op: "exec", Box: "p1", Cwd: "src", Command: "npm test", TimeoutMs: 1000},
		{Op: "exec", Box: "p1", Command: "npm run dev", TimeoutMs: 1000, Background: true, LogName: "dev"},
		{Op: "preview", Box: "p1", Port: 5173},
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
	for _, op := range []string{"ensure", "stop", "destroy", "exec", "ps", "preview", "netlog"} {
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
	for _, want := range []string{"<<'MYCEL_EOF_ab'\nnpm run dev\nMYCEL_EOF_ab\n", "setsid nohup /bin/bash -l /cache/run/dev.sh > /cache/logs/dev.log 2>&1 < /dev/null &"} {
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
