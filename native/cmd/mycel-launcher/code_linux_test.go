package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mycel/native/internal/plan"
)

func codeGoldenParams() codeParams {
	return codeParams{
		EtcDir: "/var/lib/mycel/root/sandbox-etc", Helper: "/var/lib/mycel/root/mycel-sandbox", Landlock: "required",
		Interp: "/usr/bin/python3", Script: "/.code/main.py",
		Libs: []libMount{{path: "/lib", link: "usr/lib", exists: true}, {path: "/lib64", link: "usr/lib64", exists: true}, {path: "/lib32"}},
		Bins: []libMount{{path: "/bin", link: "usr/bin", exists: true}, {path: "/sbin", link: "usr/sbin", exists: true}},
		ExecAllow: []string{"/usr"}, WorkFd: 3, CodeFd: 4,
	}
}

// docs/DECISIONS.md "Code sandbox": exact argv of a python run on Debian 13 (usrmerge)
const goldenCode = `--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-net --unshare-cgroup-try --disable-userns ` +
	`--die-with-parent --new-session --cap-drop ALL --hostname mycel-code --ro-bind /usr /usr ` +
	`--symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --symlink usr/sbin /sbin ` +
	`--ro-bind /etc/ld.so.cache /etc/ld.so.cache --ro-bind-try /etc/alternatives /etc/alternatives ` +
	`--ro-bind /var/lib/mycel/root/sandbox-etc/passwd /etc/passwd --ro-bind /var/lib/mycel/root/sandbox-etc/group /etc/group ` +
	`--ro-bind /var/lib/mycel/root/sandbox-etc/hosts /etc/hosts --ro-bind /var/lib/mycel/root/sandbox-etc/nsswitch.conf /etc/nsswitch.conf ` +
	`--proc /proc --dev /dev --size 67108864 --tmpfs /dev/shm --size 268435456 --tmpfs /tmp ` +
	`--bind-fd 3 /work --ro-bind-data 4 /.code/main.py --ro-bind /var/lib/mycel/root/mycel-sandbox /.sbx/mycel-sandbox ` +
	`--remount-ro / --chdir /work -- /.sbx/mycel-sandbox exec --landlock required --exec-allow /usr -- /usr/bin/python3 /.code/main.py`

func TestCodeArgsGolden(t *testing.T) {
	a, err := buildCodeArgs(codeGoldenParams())
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(a, " ")
	if got != goldenCode {
		t.Fatalf("argv differs:\n got %s\nwant %s", got, goldenCode)
	}
	// nothing of the chat folder beyond /work, the install, the engine, the tools socket, the CA, /sys, /run
	for _, bad := range []string{"/agent", "tools.sock", "engines", "mycel-bridge", "cert.pem", "/sys", "/run", "--share-net", "--bind /"} {
		if strings.Contains(" "+got+" ", bad) {
			t.Errorf("argv contains %q", bad)
		}
	}
}

func TestCodeArgsRefuse(t *testing.T) {
	for name, f := range map[string]func(*codeParams){
		"relative interpreter": func(p *codeParams) { p.Interp = "python3" },
		"script with newline":  func(p *codeParams) { p.Script = "/.code/m\n.py" },
		"same fds":             func(p *codeParams) { p.CodeFd = 3 },
		"stdio fd":             func(p *codeParams) { p.WorkFd = 1 },
		"exec-allow relative":  func(p *codeParams) { p.ExecAllow = []string{"usr"} },
	} {
		p := codeGoldenParams()
		f(&p)
		if _, err := buildCodeArgs(p); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestCheckCode(t *testing.T) {
	ok := codeRequest{TurnID: "t_1", Lang: "python", Code: "print(1)"}
	if d, err := checkCode(&ok); err != nil || d != codeDefaultTimeout {
		t.Fatalf("default: %v %v", d, err)
	}
	long := ok
	long.TimeoutMs = 3_600_000
	if d, _ := checkCode(&long); d != codeMaxTimeout {
		t.Errorf("timeout not capped: %v", d)
	}
	for _, r := range []codeRequest{
		{TurnID: "../x", Lang: "bash", Code: "id"},
		{TurnID: "t_1", Lang: "node", Code: "1"},
		{TurnID: "t_1", Lang: "bash", Code: ""},
		{TurnID: "t_1", Lang: "bash", Code: strings.Repeat("x", codeMaxBytes+1)},
	} {
		if _, err := checkCode(&r); err == nil {
			t.Errorf("accepted %+v", r.Lang)
		}
	}
}

func TestCodeLimits(t *testing.T) {
	basic := plan.Limits{TurnMaxMiB: 800, TurnPidsMax: 256}
	if codeMemMiB(basic) != 400 || codePids(basic) != 128 {
		t.Errorf("basic: %d MiB %d pids", codeMemMiB(basic), codePids(basic))
	}
	small := plan.Limits{TurnMaxMiB: 300, TurnPidsMax: 64}
	if codeMemMiB(small) != 256 || codePids(small) != 64 {
		t.Errorf("small: %d MiB %d pids", codeMemMiB(small), codePids(small))
	}
}

// a crowd of small files must not hide a big one: over the entry cap counts as over the limit
func TestOverDiskEntryCap(t *testing.T) {
	d := t.TempDir()
	if overDisk(d, 1<<20) {
		t.Fatal("empty folder over the limit")
	}
	if err := os.WriteFile(filepath.Join(d, "big"), make([]byte, 2<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	if !overDisk(d, 1<<20) {
		t.Error("2 MiB file not over a 1 MiB limit")
	}
	_, complete := folderBytes(d, 1)
	if complete {
		t.Error("walk past the entry cap reported complete")
	}
}

func TestCodeAllowedFailsClosed(t *testing.T) {
	saved := lx
	defer func() { lx = saved }()
	lx.bwrap = false
	if codeAllowed(plan.Limits{CodeSandbox: true}) == nil {
		t.Error("allowed without bwrap")
	}
	lx.bwrap, lx.code.ready = true, true
	if codeAllowed(plan.Limits{CodeSandbox: false}) == nil {
		t.Error("allowed without the plan")
	}
	if codeAllowed(plan.Limits{CodeSandbox: true}) != nil {
		t.Error("refused with bwrap, runtimes and plan")
	}
	lx.code.ready = false
	if codeAllowed(plan.Limits{CodeSandbox: true}) == nil {
		t.Error("allowed without runtimes")
	}
}
