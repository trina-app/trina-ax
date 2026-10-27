package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Preflight is what `mycel-ctl preflight --json` reports (spec 3.5.1 step 1, 3.6.5). Problems stop an install;
// warnings are shown (and repeated by the diagnostics).
type Preflight struct {
	OK                  bool     `json:"ok"`
	Problems            []string `json:"problems"`
	Warnings            []string `json:"warnings"`
	Hosted              bool     `json:"hosted"`
	OS                  string   `json:"os"`
	OSVersion           string   `json:"osVersion"`
	Arch                string   `json:"arch"`
	Kernel              string   `json:"kernel"`
	LandlockABI         int      `json:"landlockAbi"`
	Cgroup2             bool     `json:"cgroup2"`
	CgroupControllers   []string `json:"cgroupControllers"`
	CgroupDelegation    bool     `json:"cgroupDelegation"`
	Systemd             bool     `json:"systemd"`
	UserNamespaces      bool     `json:"userNamespaces"`
	AppArmorRestrictsNS bool     `json:"apparmorRestrictsUserns"`
	PtraceScope         int      `json:"ptraceScope"`
	MergedUsr           bool     `json:"mergedUsr"`
	CPUFlags            []string `json:"cpuFlags"`
	Bwrap               string   `json:"bwrap"`
	Nft                 string   `json:"nft"`
}

// sysPaths lets tests point preflight at a fake /proc and /sys.
type sysPaths struct {
	root string // prefix for /proc, /sys, /etc, /run
}

func (s sysPaths) p(path string) string { return s.root + path }

func (s sysPaths) read(path string) string {
	b, _ := os.ReadFile(s.p(path))
	return strings.TrimSpace(string(b))
}

func cmdPreflight(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("preflight", flag.ContinueOnError)
	e.flags(fs)
	asJSON := fs.Bool("json", false, "JSON output")
	hosted := fs.Bool("hosted", false, "hosting rules (Landlock ABI 6, cgroup delegation, ptrace_scope >= 1 required)")
	if err := fs.Parse(args); err != nil {
		return 2, usageError{err.Error()}
	}
	p := preflight(sysPaths{}, *hosted, runtime.GOARCH, landlockABI())
	p.Bwrap = toolVersion("/usr/bin/bwrap", "--version")
	p.Nft = toolVersion(e.nft, "--version")
	judgeTools(&p)
	if *asJSON {
		printJSON(e.stdout, p)
	} else {
		fmt.Fprintf(e.stdout, "%s %s, %s, kernel %s, Landlock ABI %d, cgroup v2 %v (%s), ptrace_scope %d, bwrap %s, nft %s\n",
			p.OS, p.OSVersion, p.Arch, p.Kernel, p.LandlockABI, p.Cgroup2, strings.Join(p.CgroupControllers, " "), p.PtraceScope, orNone(p.Bwrap), orNone(p.Nft))
		for _, w := range p.Warnings {
			fmt.Fprintln(e.stdout, "warning: "+w)
		}
		for _, x := range p.Problems {
			fmt.Fprintln(e.stdout, "problem: "+x)
		}
		if p.OK {
			fmt.Fprintln(e.stdout, "ok")
		}
	}
	if !p.OK {
		return 1, nil
	}
	return 0, nil
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

var verRe = regexp.MustCompile(`\d+\.\d+(\.\d+)?`)

func toolVersion(bin string, arg string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, arg).CombinedOutput()
	if err != nil {
		return ""
	}
	return verRe.FindString(string(out))
}

// versionAtLeast compares dotted numbers.
func versionAtLeast(v, min string) bool {
	a, b := strings.Split(v, "."), strings.Split(min, ".")
	for i := 0; i < len(b); i++ {
		x, y := 0, 0
		if i < len(a) {
			x, _ = strconv.Atoi(a[i])
		}
		y, _ = strconv.Atoi(b[i])
		if x != y {
			return x > y
		}
	}
	return true
}

func judgeTools(p *Preflight) {
	switch {
	case p.Bwrap == "":
		p.Warnings = append(p.Warnings, "bubblewrap is not installed (the installer installs it: apt-get install bubblewrap)")
	case !versionAtLeast(p.Bwrap, "0.8.0"):
		p.Problems = append(p.Problems, "bubblewrap "+p.Bwrap+" is older than 0.8.0 (--disable-userns)")
	}
	if p.Nft == "" {
		p.Warnings = append(p.Warnings, "nftables is not installed (the installer installs it: apt-get install nftables)")
	}
	p.OK = len(p.Problems) == 0
}

// preflight reads the machine's facts (everything but the tools) and judges them.
func preflight(s sysPaths, hosted bool, goarch string, abi int) Preflight {
	p := Preflight{Hosted: hosted, Problems: []string{}, Warnings: []string{}, LandlockABI: abi, PtraceScope: -1}
	osr := parseOSRelease(s.read("/etc/os-release"))
	p.OS, p.OSVersion = osr["ID"], osr["VERSION_ID"]
	switch {
	case p.OS == "debian" && (p.OSVersion == "12" || p.OSVersion == "13"):
	case p.OS == "ubuntu" && p.OSVersion == "24.04":
	default:
		p.Problems = append(p.Problems, fmt.Sprintf("%s %s is not supported (Debian 12/13, Ubuntu 24.04)", orNone(p.OS), p.OSVersion))
	}
	switch goarch {
	case "amd64":
		p.Arch = "x86_64"
	case "arm64":
		p.Arch = "aarch64"
	default:
		p.Arch = goarch
		p.Problems = append(p.Problems, "processor "+goarch+" is not supported (x86_64, aarch64)")
	}
	p.Kernel = strings.Fields(s.read("/proc/sys/kernel/osrelease") + " ?")[0]
	if !versionAtLeast(strings.SplitN(p.Kernel, "-", 2)[0], "6.1") {
		p.Problems = append(p.Problems, "kernel "+p.Kernel+" is older than 6.1")
	}
	if goarch == "amd64" {
		flags := cpuFlags(s.read("/proc/cpuinfo"))
		for _, f := range []string{"sse4_2", "avx2", "fma", "f16c"} {
			if flags[f] {
				p.CPUFlags = append(p.CPUFlags, f)
			}
		}
		if !flags["sse4_2"] {
			p.Problems = append(p.Problems, "the processor has no SSE4.2 (bun and Claude Code need it)")
		}
		if !(flags["avx2"] && flags["fma"] && flags["f16c"]) {
			p.Warnings = append(p.Warnings, "no AVX2/FMA/F16C: speech-to-text uses the slower build")
		}
	}
	// cgroup v2 and the controllers a delegated unit needs
	p.Cgroup2 = s.read("/sys/fs/cgroup/cgroup.controllers") != "" || fileExists(s.p("/sys/fs/cgroup/cgroup.procs")) && !fileExists(s.p("/sys/fs/cgroup/memory/memory.limit_in_bytes"))
	p.CgroupControllers = strings.Fields(s.read("/sys/fs/cgroup/cgroup.controllers"))
	have := map[string]bool{}
	for _, c := range p.CgroupControllers {
		have[c] = true
	}
	p.Systemd = fileExists(s.p("/run/systemd/system"))
	p.CgroupDelegation = p.Cgroup2 && have["memory"] && have["pids"] && have["cpu"] && p.Systemd
	if !p.Cgroup2 {
		p.Problems = append(p.Problems, "cgroup v2 is not mounted at /sys/fs/cgroup (cgroup v1 is not supported)")
	}
	if !p.Systemd {
		p.Warnings = append(p.Warnings, "systemd is not running as PID 1 (install with --no-systemd; not supported for hosting)")
	}
	if !p.CgroupDelegation {
		msg := "per-turn memory and process limits are not available (cgroup v2 with memory, pids and cpu delegated by systemd)"
		if hosted {
			p.Problems = append(p.Problems, msg)
		} else {
			p.Warnings = append(p.Warnings, msg)
		}
	}
	// unprivileged user namespaces (bwrap is not setuid on Debian/Ubuntu)
	p.UserNamespaces = s.read("/proc/sys/kernel/unprivileged_userns_clone") != "0" && s.read("/proc/sys/user/max_user_namespaces") != "0"
	if !p.UserNamespaces {
		p.Problems = append(p.Problems, "unprivileged user namespaces are off (kernel.unprivileged_userns_clone / user.max_user_namespaces): bubblewrap cannot isolate turns")
	}
	p.AppArmorRestrictsNS = s.read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") == "1"
	if p.AppArmorRestrictsNS {
		p.Warnings = append(p.Warnings, "AppArmor restricts unprivileged user namespaces: the installer adds a profile for /usr/bin/bwrap only")
	}
	// Landlock
	switch {
	case abi < 1:
		msg := "Landlock is not available: the engine could run programs from the system libraries"
		if hosted {
			p.Problems = append(p.Problems, msg)
		} else {
			p.Warnings = append(p.Warnings, msg)
		}
	case abi < 6:
		msg := fmt.Sprintf("Landlock ABI %d (kernel older than 6.12): turns cannot be kept apart on abstract unix sockets and signals", abi)
		if hosted {
			p.Problems = append(p.Problems, msg)
		} else {
			p.Warnings = append(p.Warnings, msg)
		}
	}
	// Yama
	if v, err := strconv.Atoi(s.read("/proc/sys/kernel/yama/ptrace_scope")); err == nil {
		p.PtraceScope = v
	}
	if p.PtraceScope < 1 {
		msg := "kernel.yama.ptrace_scope is 0 (the installer sets 1; in a container the host must)"
		if hosted {
			p.Problems = append(p.Problems, msg)
		} else {
			p.Warnings = append(p.Warnings, msg)
		}
	}
	// merged /usr: the sandbox binds /usr/lib and recreates /lib* links
	l, _ := os.Readlink(s.p("/lib"))
	p.MergedUsr = l == "usr/lib" || l == "/usr/lib"
	if !p.MergedUsr {
		p.Warnings = append(p.Warnings, "/lib is not a link to /usr/lib (not a merged-/usr system): the sandbox binds /lib separately")
	}
	p.OK = len(p.Problems) == 0
	return p
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func parseOSRelease(text string) map[string]string {
	m := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if ok {
			m[k] = strings.Trim(v, `"'`)
		}
	}
	return m
}

func cpuFlags(cpuinfo string) map[string]bool {
	m := map[string]bool{}
	sc := bufio.NewScanner(strings.NewReader(cpuinfo))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if ok && strings.TrimSpace(k) == "flags" {
			for _, f := range strings.Fields(v) {
				m[f] = true
			}
			break
		}
	}
	return m
}
