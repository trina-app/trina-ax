package main

// Safe operations 1A on a systemd install (docs/SAFE-OPS-1A.md "Administrator rollout"; QA 2026-10-30 B1). A 1A job
// runs only when two install parts are there, and a standard install had neither:
//
//   - the bounded group: the server, its converters and every engine turn share one cgroup with finite memory (at most
//     4 GiB, 640 MiB free when a job starts), no swap, at most 512 tasks and 4 CPUs (server/src/safe-ops/envelope.ts).
//     Both units always run in <id>.slice (Slice= in their templates); the slice has limits only while 1A is on, so a
//     team without 1A keeps the machine's whole memory, CPUs and the units' own task limits.
//   - root-owned programs: a 1A job runs only executables root owns, in folders only root can write
//     (server/src/safe-ops/runner.ts trustedFile). The app's version folders belong to the server account (in-app
//     updates write them), so root keeps its own copies of mycel-safeops and pandoc in <base>/root/safe-ops/ (the
//     server unit's MYCEL_SAFE_OPS_BIN), copied only from a verified release: the installer's kit, `mycel-ctl update`'s
//     bundle, or here the installed version checked against its release signature.
//
//	mycel-ctl safe-ops on   [--json] [--no-restart] [--max-wait S]   MYCEL_SAFE_OPS_1A=1, bounded slice, restart
//	mycel-ctl safe-ops off  [--json] [--no-restart] [--max-wait S]   flag and limits removed, restart
//	mycel-ctl safe-ops status [--json]
//
// The installer, `render-units` and `update` render the slice from /etc/default/<id>, so an install whose flag was set
// by hand gets its bounded slice with the next upgrade.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"mycel/native/internal/bundle"
	"mycel/native/internal/plan"
)

// defaultsDir holds /etc/default/<id> (the server unit's EnvironmentFile), cgroupRoot is the cgroup v2 mount,
// systemdUnitDir the installed units. Tests point them elsewhere.
var (
	defaultsDir    = "/etc/default"
	cgroupRoot     = "/sys/fs/cgroup"
	systemdUnitDir = "/etc/systemd/system"
)

// safeOpsFlagName is the server's switch (server/src/safe-ops/runner.ts safeOpsEnabled: exactly "1" is on).
const safeOpsFlagName = "MYCEL_SAFE_OPS_1A"

// safeOpsCopies are the 1A programs root keeps its own copy of: path in a version folder -> name in root/safe-ops/.
// scripts/release/publish-server.ts ROOT_COPIES has the same list: a release that changes one of them needs root.
var safeOpsCopies = []struct{ Rel, Name string }{{"native/mycel-safeops", "mycel-safeops"}, {"bin/pandoc", "pandoc"}}

// SliceLimits bound <id>.slice while 1A is on (envelope.ts ENVELOPE_MAX: memory <= 4 GiB, tasks <= 512, CPUs <= 4, swap 0;
// at least 640 MiB free when a job starts). MemoryHigh keeps the page cache 768 MiB below MemoryMax, so the free
// memory a job needs is there on a busy server too.
type SliceLimits struct {
	MemoryMaxMiB  int `json:"memoryMaxMiB"`
	MemoryHighMiB int `json:"memoryHighMiB"`
	Tasks         int `json:"tasks"`
	CPUs          int `json:"cpus"`
}

const (
	sliceMaxMiB     = 4096 // ENVELOPE_MAX.memory
	sliceHostMiB    = 512  // left to the system outside the slice
	sliceHeadMiB    = 768  // MemoryMax - MemoryHigh (> the 640 MiB a job needs free)
	sliceMinHighMiB = 1024 // the server and one engine turn
	sliceTasks      = 512  // ENVELOPE_MAX.pids
	sliceMaxCPUs    = 4    // ENVELOPE_MAX.cpus
)

// computeSliceLimits: memory MiB and CPUs of the machine (or the plan) -> the slice's bounds, or why 1A cannot run.
func computeSliceLimits(memMiB, cpus int) (SliceLimits, error) {
	max := memMiB - sliceHostMiB
	if max > sliceMaxMiB {
		max = sliceMaxMiB
	}
	if max-sliceHeadMiB < sliceMinHighMiB {
		return SliceLimits{}, fmt.Errorf("safe operations 1A need at least %d MiB of memory (this server has %d MiB)", sliceMinHighMiB+sliceHeadMiB+sliceHostMiB, memMiB)
	}
	if cpus > sliceMaxCPUs {
		cpus = sliceMaxCPUs
	}
	if cpus < 1 {
		cpus = 1
	}
	return SliceLimits{MemoryMaxMiB: max, MemoryHighMiB: max - sliceHeadMiB, Tasks: sliceTasks, CPUs: cpus}, nil
}

// sliceResources: the tenant's plan (root/plan.json, hosted) or this machine's memory and CPUs. Tests replace it.
var sliceResources = func(in *Install) (int, int) {
	if b, err := readRootFile(filepath.Join(in.Base, "root", "plan.json"), plan.MaxFileBytes); err == nil {
		if p, err := plan.Parse(b); err == nil && p.MemoryMiB > 0 {
			c := p.CPUCores
			if c <= 0 {
				c = runtime.NumCPU()
			}
			return p.MemoryMiB, c
		}
	}
	return plan.MachineMemoryMiB(), runtime.NumCPU()
}

// sliceLimitsText is the slice template's @SLICE_LIMITS@: the [Slice] lines while 1A is on, else a comment.
func sliceLimitsText(in *Install) string {
	if !safeOpsFlag(in.ID) {
		return "# no limits: safe operations 1A is off (`mycel-ctl safe-ops on` bounds this group)"
	}
	l, err := computeSliceLimits(sliceResources(in))
	if err != nil {
		return "# no limits: " + err.Error()
	}
	return fmt.Sprintf("MemoryMax=%dM\nMemoryHigh=%dM\nMemorySwapMax=0\nTasksMax=%d\nCPUQuota=%d%%", l.MemoryMaxMiB, l.MemoryHighMiB, l.Tasks, l.CPUs*100)
}

// safeOpsFlag: /etc/default/<id> sets MYCEL_SAFE_OPS_1A=1 (the last assignment wins, as for systemd).
func safeOpsFlag(id string) bool {
	b, err := readRootFile(filepath.Join(defaultsDir, id), 64<<10)
	if err != nil {
		return false
	}
	on := false
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if ok && strings.TrimSpace(k) == safeOpsFlagName {
			on = strings.Trim(strings.TrimSpace(v), `"'`) == "1"
		}
	}
	return on
}

// setSafeOpsFlag rewrites /etc/default/<id>: every line of ours goes, the others stay (mycel-enroll's backup window,
// MYCEL_REMOTE_MCP_ORIGIN, the administrator's own), and with on one MYCEL_SAFE_OPS_1A=1 is added.
func setSafeOpsFlag(id string, on bool) error {
	p := filepath.Join(defaultsDir, id)
	old, err := readRootFile(p, 64<<10)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	var lines []string
	sc := bufio.NewScanner(bytes.NewReader(old))
	for sc.Scan() {
		l := sc.Text()
		if k, _, ok := strings.Cut(strings.TrimSpace(l), "="); ok && strings.TrimSpace(k) == safeOpsFlagName {
			continue
		}
		lines = append(lines, l)
	}
	if on {
		lines = append(lines, safeOpsFlagName+"=1")
	}
	if !on && len(lines) == 0 {
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(defaultsDir, 0o755); err != nil {
		return err
	}
	return writeRootFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
}

// ---------- the root copies ----------

// SafeOpsProgram is one root copy's state.
type SafeOpsProgram struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	OK      bool   `json:"ok"`
	Problem string `json:"problem,omitempty"`
}

// rootCopyProblem: the copy must be a regular root-owned executable nobody else can write, in root/safe-ops/ (root
// 755), with the bytes the version folder's manifest lists (want: sha256, "" = not checked). The server account runs
// and hashes it (ready.ts), so the folder and the file must be readable and searchable by others (a root umask of 077
// would otherwise leave a copy only root can use, which this check would call fine).
func rootCopyProblem(e *env, name, want string) string {
	dir := e.root("safe-ops")
	if err := rootOwnedDir(dir); err != nil {
		return err.Error()
	}
	var dst syscall.Stat_t
	if err := syscall.Lstat(dir, &dst); err != nil || dst.Mode&0o005 != 0o005 {
		return dir + " must be readable and searchable by the server account (755)"
	}
	p := e.root("safe-ops", name)
	var st syscall.Stat_t
	if err := syscall.Lstat(p, &st); err != nil {
		return p + " is missing"
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || int(st.Uid) != rootUID || st.Mode&0o022 != 0 || st.Mode&0o005 != 0o005 {
		return p + " must be a root-owned executable (755) that group and others cannot write"
	}
	if want != "" {
		if got, _, err := bundle.HashFile(p); err != nil || got != want {
			return p + " is not the running version's copy"
		}
	}
	return ""
}

// currentManifest reads app/current's manifest (and checks its signature unless the install allows unsigned
// releases). The bytes are read once into memory: the server account can change that folder.
func currentManifest(e *env, in *Install) (*bundle.Manifest, string, bool, error) {
	v := currentVersion(e.base)
	if v == "" {
		return nil, "", false, fmt.Errorf("app/current names no version")
	}
	dir := filepath.Join(e.base, "app", "versions", v)
	raw, err := readSmall(filepath.Join(dir, "manifest.json"), 16<<20)
	if err != nil {
		return nil, v, false, err
	}
	signed := false
	if sig, err := readSmall(filepath.Join(dir, "manifest.sig"), 4<<10); err == nil {
		if err := bundle.VerifySig(raw, sig, safeOpsKeys); err != nil {
			return nil, v, false, fmt.Errorf("version %s: %v", v, err)
		}
		signed = true
	} else if !in.AllowUnsigned {
		return nil, v, false, fmt.Errorf("version %s has no release signature", v)
	}
	var m bundle.Manifest
	if json.Unmarshal(raw, &m) != nil || m.Format != 1 || m.Version != v {
		return nil, v, false, fmt.Errorf("version %s: manifest unreadable", v)
	}
	return &m, v, signed, nil
}

// safeOpsKeys are the release keys the installed version's signature is checked with (tests add theirs).
var safeOpsKeys = append([]string{}, bundle.ReleaseKeys...)

// readSmall reads a regular file without following a link, at most max bytes.
func readSmall(p string, max int64) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > max {
		return nil, fmt.Errorf("%s is not a small regular file", p)
	}
	return io.ReadAll(io.LimitReader(f, max))
}

// ensureSafeOpsDir makes root/safe-ops/ a root-owned folder with mode 755 whatever the caller's umask (`sudo` keeps
// the administrator's: 077 would leave a folder the server account cannot enter).
func ensureSafeOpsDir(e *env) (string, error) {
	dir := e.root("safe-ops")
	if err := os.Mkdir(dir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return "", err
	}
	if err := rootOwnedDir(dir); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// installRootCopy copies src (any owner) into root/safe-ops/<name>: first into a root-only temp file, whose size and
// hash must then equal the manifest's (so a file swapped while it is read never lands, and a huge or endless file in
// the server account's folder cannot fill the disk as root), then renamed into place 0755.
func installRootCopy(e *env, src, name, want string, size int64) error {
	dir, err := ensureSafeOpsDir(e)
	if err != nil {
		return err
	}
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	if st, err := in.Stat(); err != nil || !st.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", src)
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.%d.tmp", name, time.Now().UnixNano()))
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o700)
	if err != nil {
		return err
	}
	n, cerr := io.Copy(out, io.LimitReader(in, size+1))
	if err := out.Close(); cerr == nil {
		cerr = err
	}
	if cerr == nil && n != size {
		cerr = fmt.Errorf("%s is not the size its release lists", src)
	}
	if cerr == nil {
		if got, _, err := bundle.HashFile(tmp); err != nil || got != want {
			cerr = fmt.Errorf("%s changed while it was copied", src)
		}
	}
	if cerr == nil {
		cerr = os.Chmod(tmp, 0o755)
	}
	if cerr == nil {
		cerr = os.Rename(tmp, filepath.Join(dir, name))
	}
	if cerr != nil {
		os.Remove(tmp)
	}
	return cerr
}

// ensureSafeOpsCopies makes root/safe-ops/ hold the running version's programs. A signed install takes them from the
// installed version after checking its release signature and the copies' hashes; an unsigned (development) install
// cannot prove what the server account's folder holds, so there only the installer with a kit can put them in.
func ensureSafeOpsCopies(e *env, in *Install) ([]SafeOpsProgram, []string, error) {
	m, v, signed, err := currentManifest(e, in)
	if err != nil {
		return nil, nil, err
	}
	var progs []SafeOpsProgram
	var notes []string
	for _, c := range safeOpsCopies {
		f, ok := m.Files[c.Rel]
		if !ok {
			return nil, nil, fmt.Errorf("version %s has no %s", v, c.Rel)
		}
		p := SafeOpsProgram{Name: c.Name, Path: e.root("safe-ops", c.Name)}
		if prob := rootCopyProblem(e, c.Name, f.Sha256); prob != "" {
			if !signed {
				return nil, nil, fmt.Errorf("%s; this install accepts unsigned releases, so mycel-ctl cannot verify the installed copy: run `sudo ./install-linux.sh update --from <kit>` with the kit of %s", prob, v)
			}
			if err := installRootCopy(e, filepath.Join(e.base, "app", "versions", v, c.Rel), c.Name, f.Sha256, f.Size); err != nil {
				return nil, nil, fmt.Errorf("copying %s: %v", c.Rel, err)
			}
			notes = append(notes, fmt.Sprintf("installed root/safe-ops/%s from the verified version %s", c.Name, v))
		}
		p.OK = true
		progs = append(progs, p)
	}
	return progs, notes, nil
}

// ---------- status ----------

// SafeOpsStatus is `mycel-ctl safe-ops status --json` (and the result of on / off).
type SafeOpsStatus struct {
	On       bool              `json:"on"`
	Ready    bool              `json:"ready"`
	Programs []SafeOpsProgram  `json:"programs"`
	Slice    map[string]string `json:"slice"`
	Limits   *SliceLimits      `json:"limits,omitempty"`
	Problems []string          `json:"problems,omitempty"`
	Notes    []string          `json:"notes,omitempty"`
}

func safeOpsStatus(e *env, in *Install) *SafeOpsStatus {
	s := &SafeOpsStatus{On: safeOpsFlag(in.ID), Slice: map[string]string{}}
	var want map[string]string
	if m, _, _, err := currentManifest(e, in); err == nil {
		want = map[string]string{}
		for _, c := range safeOpsCopies {
			want[c.Name] = m.Files[c.Rel].Sha256
		}
	} else {
		s.Problems = append(s.Problems, "installed version: "+err.Error())
	}
	for _, c := range safeOpsCopies {
		p := SafeOpsProgram{Name: c.Name, Path: e.root("safe-ops", c.Name)}
		if p.Problem = rootCopyProblem(e, c.Name, want[c.Name]); p.Problem == "" {
			p.OK = true
		} else {
			s.Problems = append(s.Problems, p.Problem)
		}
		s.Programs = append(s.Programs, p)
	}
	if l, err := computeSliceLimits(sliceResources(in)); err == nil {
		s.Limits = &l
	} else {
		s.Problems = append(s.Problems, err.Error())
	}
	if !ownSlice(in.ID) {
		s.Problems = append(s.Problems, fmt.Sprintf("the install id %q is one of systemd's own slices, so the install has no slice of its own; 1A needs an install with another --id", in.ID))
	}
	dir := filepath.Join(cgroupRoot, sliceUnit(in.ID))
	for _, f := range []string{"memory.max", "memory.high", "memory.swap.max", "memory.current", "pids.max", "cpu.max"} {
		if b, err := os.ReadFile(filepath.Join(dir, f)); err == nil {
			s.Slice[f] = strings.TrimSpace(string(b))
		}
	}
	bounded := s.Slice["memory.swap.max"] == "0" && s.Slice["memory.max"] != "" && s.Slice["memory.max"] != "max" &&
		s.Slice["pids.max"] != "" && s.Slice["pids.max"] != "max" && !strings.HasPrefix(s.Slice["cpu.max"], "max")
	units := true
	for _, u := range []string{"server", "launcher"} {
		if _, err := os.Stat(filepath.Join(dir, in.ID+"-"+u+".service")); err != nil {
			units = false
		}
	}
	if s.On {
		if !bounded {
			s.Problems = append(s.Problems, sliceUnit(in.ID)+" has no memory, task and CPU limits")
		}
		if !units {
			s.Problems = append(s.Problems, "the server and the launcher are not running in "+sliceUnit(in.ID))
		}
		if mx, err := strconv.ParseInt(s.Slice["memory.max"], 10, 64); err == nil {
			if cur, err := strconv.ParseInt(s.Slice["memory.current"], 10, 64); err == nil && mx-cur < 640<<20 {
				s.Notes = append(s.Notes, fmt.Sprintf("only %d MiB free in %s now (a job needs 640 MiB)", (mx-cur)>>20, sliceUnit(in.ID)))
			}
		}
	}
	s.Ready = s.On && len(s.Problems) == 0
	return s
}

// ---------- on / off ----------

// safeOpsLiveTurns counts running turns before the restart (tests replace it).
var safeOpsLiveTurns = func(e *env, in *Install) (int, error) {
	u := &updater{e: e, in: in}
	return u.launcherLiveTurns()
}

func cmdSafeOps(e *env, args []string) (int, error) {
	pos, rest := positional(args)
	if len(pos) != 1 || (pos[0] != "on" && pos[0] != "off" && pos[0] != "status") {
		return 2, usageError{"safe-ops on|off|status [--json] [--no-restart] [--max-wait S]"}
	}
	fs := flag.NewFlagSet("safe-ops", flag.ContinueOnError)
	e.flags(fs)
	asJSON := fs.Bool("json", false, "JSON output")
	noRestart := fs.Bool("no-restart", false, "change the files only; restart the units yourself")
	maxWait := fs.Int("max-wait", 120, "seconds to wait for running turns before the restart")
	if err := fs.Parse(rest); err != nil {
		return 2, usageError{err.Error()}
	}
	if err := requireRoot(); err != nil {
		return 2, err
	}
	if err := checkBase(e.base); err != nil {
		return 1, err
	}
	in, err := loadInstall(e)
	if err != nil {
		return 1, err
	}
	out := func(s *SafeOpsStatus, code int, err error) (int, error) {
		if *asJSON {
			printJSON(e.stdout, s)
		} else {
			fmt.Fprintf(e.stdout, "safe operations 1A: %s\n", map[bool]string{true: "on", false: "off"}[s.On])
			for _, p := range s.Programs {
				fmt.Fprintf(e.stdout, "  program %s: %s\n", p.Path, map[bool]string{true: "ok", false: p.Problem}[p.OK])
			}
			if s.Limits != nil {
				fmt.Fprintf(e.stdout, "  %s while on: MemoryMax=%dM MemoryHigh=%dM MemorySwapMax=0 TasksMax=%d CPUQuota=%d%%\n", sliceUnit(in.ID), s.Limits.MemoryMaxMiB, s.Limits.MemoryHighMiB, s.Limits.Tasks, s.Limits.CPUs*100)
			}
			if len(s.Slice) > 0 {
				fmt.Fprintf(e.stdout, "  %s now: memory.max=%s pids.max=%s cpu.max=%s memory.swap.max=%s\n", sliceUnit(in.ID), s.Slice["memory.max"], s.Slice["pids.max"], s.Slice["cpu.max"], s.Slice["memory.swap.max"])
			}
			for _, p := range s.Problems {
				fmt.Fprintln(e.stdout, "  problem: "+p)
			}
			for _, n := range s.Notes {
				fmt.Fprintln(e.stdout, "  note: "+n)
			}
			if s.On {
				fmt.Fprintf(e.stdout, "  ready: %v\n", s.Ready)
			}
		}
		return code, err
	}
	if pos[0] == "status" {
		return out(safeOpsStatus(e, in), 0, nil)
	}
	on := pos[0] == "on"
	systemd := in.Systemd && fileExists(systemdRunDir)
	var notes []string
	if on {
		if !systemd {
			return 1, fmt.Errorf("safe operations 1A need the systemd install (the bounded group is a systemd slice)")
		}
		if !ownSlice(in.ID) {
			return 1, fmt.Errorf("the install id %q is one of systemd's own slices: 1A needs an install with another --id", in.ID)
		}
		if _, err := computeSliceLimits(sliceResources(in)); err != nil {
			return 1, err
		}
		_, n, err := ensureSafeOpsCopies(e, in)
		if err != nil {
			return 1, err
		}
		notes = append(notes, n...)
	}
	if err := setSafeOpsFlag(in.ID, on); err != nil {
		return 1, fmt.Errorf("/etc/default/%s: %v", in.ID, err)
	}
	if systemd {
		if _, _, err := renderUnits(in, e.root("systemd"), systemdUnitDir); err != nil {
			return 1, fmt.Errorf("units: %v", err)
		}
		if o, err := exec.Command(e.systemctl, "daemon-reload").CombinedOutput(); err != nil {
			return 1, fmt.Errorf("daemon-reload: %v %s", err, o)
		}
		if *noRestart {
			notes = append(notes, fmt.Sprintf("not restarted: stop %[1]s-server and %[1]s-launcher, then `systemctl stop %[2]s`, then start both", in.ID, sliceUnit(in.ID)))
		} else {
			deadline := time.Now().Add(time.Duration(*maxWait) * time.Second)
			for {
				n, err := safeOpsLiveTurns(e, in)
				if (err == nil && n == 0) || !time.Now().Before(deadline) {
					break
				}
				time.Sleep(2 * time.Second)
			}
			if err := restartInSlice(e, in); err != nil {
				return 1, err
			}
		}
	}
	s := safeOpsStatus(e, in)
	s.Notes = append(notes, s.Notes...)
	if !on {
		s.Notes = append(s.Notes, "chats that ran a 1A job stay without web and connector tools; the others have them again")
	}
	return out(s, 0, nil)
}

// restartInSlice restarts the server and the launcher in a fresh slice (sliceUnit): systemd applies a slice unit's changed
// limits only when it creates the slice's cgroup again (daemon-reload alone leaves the running slice as it was;
// systemd 257, Debian 13), so both units stop, the empty slice stops, and both start again.
func restartInSlice(e *env, in *Install) error {
	steps := [][]string{{"stop", in.ID + "-server.service", in.ID + "-launcher.service"}}
	if ownSlice(in.ID) { // never system.slice (ownSlice)
		steps = append(steps, []string{"stop", sliceUnit(in.ID)})
	}
	steps = append(steps, []string{"start", in.ID + "-launcher.service", in.ID + "-server.service"})
	for _, c := range steps {
		if o, err := exec.Command(e.systemctl, c...).CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl %s: %v %s", strings.Join(c, " "), err, strings.TrimSpace(string(o)))
		}
	}
	return nil
}
