package main

// The system packages and programs of the one list (scripts/system/packages.json, docs/DECISIONS.md "One list of system
// packages"). Every bundle since the list came has root/packages.json, its flat copy root/packages.flat and its reader
// root/packages.sh; `packages.sh sync` brings the machine to them (missing packages, the pinned browser) and writes
// root/packages.synced: the sha256 of the list it synced to and the result.
//
// When it runs: after an update's root files and app (run's deferred syncAfter), and whenever root/packages.synced does
// not match root/packages.json or this system (osIdentity: a reimage keeps the data disk and its record, not the OS).
// Where it runs: on a server with systemd, as a transient unit of its own (<id>-packages-sync.service, `mycel-ctl
// packages-sync`), started after the update and never waited for, so apt or a slow download never counts in the update
// command's time (the control plane's timeout, its roll-back and its roll-out halts see only the update). Without
// systemd (a container, the tests) it runs inline, bounded by syncInlineTimeout. That second case is how a server catches
// up after an older mycel-ctl put the root files of a release with the list in place: that binary knew nothing of the
// list, so it never synced, but it did install this binary as root/mycel-ctl. The next run of this binary, the update
// timer's within the update window (rootJob and the scheduled gate count a pending sync as root's work; the feed's release
// is installed already, so nothing is downloaded) or an administrator's `mycel-ctl update`, finds the mismatch and syncs.
// Hosted servers have no timer: the control plane's next `mycel-ctl update` does it. A sync that ended "incomplete" (a
// download or apt failed) is tried again after syncRetry; "blocked" (an administrator's step: an install from before the
// list, --skip-apt, a full disk) waits until the list changes or `install-linux.sh repair` writes a new record.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	packagesSh     = "packages.sh"
	packagesList   = "packages.json"
	packagesSynced = "packages.synced"
)

var (
	// bashPath runs packages.sh; syncTimeout bounds a whole sync in its own unit, syncInlineTimeout one inside the update
	// command (no systemd), syncRetry spaces the tries of an incomplete one (variables for the tests)
	bashPath          = "/bin/bash"
	syncTimeout       = 20 * time.Minute
	syncInlineTimeout = 10 * time.Minute
	syncRetry         = 6 * time.Hour
	// systemdRunPath starts the sync's unit; startSyncUnit runs it (a hook for the tests)
	systemdRunPath = "/usr/bin/systemd-run"
	startSyncUnit  = func(args []string) (string, error) {
		out, err := exec.Command(systemdRunPath, args...).CombinedOutput()
		return string(out), err
	}
	// syncAsUnit: run the sync as a unit of its own (systemd), not inside the update command (a hook for the tests)
	syncAsUnit = func(u *updater) bool { return u.in.Systemd && fileExists(systemdRunDir) }
	// machineIDPath and osReleasePath name this system (osIdentity; variables for the tests)
	machineIDPath = "/etc/machine-id"
	osReleasePath = "/etc/os-release"
	// syncWaitDelay: how long a stopped sync may take to end (apt and dpkg run in a session of their own and are never
	// signalled: a transaction finishes by itself)
	syncWaitDelay = 30 * time.Second
)

// SyncState is root/packages.synced (scripts/system/packages.sh pk_write_synced).
type SyncState struct {
	Format  int    `json:"format"`
	List    string `json:"list"`
	Result  string `json:"result"` // ok | incomplete | blocked
	At      string `json:"at"`
	Browser string `json:"browser"`
	Detail  string `json:"detail"`
	// OS: osIdentity of the system the sync ran on ("" in a record from before it: one catch-up sync)
	OS string `json:"os,omitempty"`
}

// osIdentity names the installed system: "<ID>-<VERSION_ID>/<machine-id>" (packages.sh pk_os_identity writes the same
// string). The machine-id is new on every clone of the image (customize.sh empties it), so a reimage that keeps the data
// disk, and root/packages.synced on it, is a new system. "" when neither file can be read (not Linux).
func osIdentity() string {
	clean := func(s string, keep func(r rune) bool) string {
		return strings.Map(func(r rune) rune {
			if keep(r) {
				return r
			}
			return -1
		}, s)
	}
	word := func(r rune) bool {
		return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-'
	}
	hex := func(r rune) bool { return r >= '0' && r <= '9' || r >= 'a' && r <= 'f' }
	osr, errO := os.ReadFile(osReleasePath)
	mid, errM := os.ReadFile(machineIDPath)
	if errO != nil && errM != nil {
		return ""
	}
	m := parseOSRelease(string(osr))
	id := clean(m["ID"], word) + "-" + clean(m["VERSION_ID"], word) + "/" + clean(string(mid), hex)
	if len(id) > 128 {
		id = id[:128]
	}
	return id
}

func readSynced(e *env) *SyncState {
	b, err := readRootFile(e.root(packagesSynced), 64<<10)
	if err != nil {
		return nil
	}
	var s SyncState
	if json.Unmarshal(b, &s) != nil || s.Format != 1 {
		return nil
	}
	return &s
}

// listSum is the sha256 of root/packages.json, "" without one (a server from before the list).
func listSum(e *env) string {
	b, err := readRootFile(e.root(packagesList), 1<<20)
	if err != nil {
		return ""
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// syncPending: is a sync root's work now, and why. Only with the list and its reader in root/. explicit: an
// administrator's (or the control plane's) own `mycel-ctl update`, which also tries a blocked sync again (the step it
// waited for may be done); the timer does not.
func syncPending(e *env, now time.Time, explicit bool) (bool, string) {
	sum := listSum(e)
	if sum == "" || !fileExists(e.root(packagesSh)) {
		return false, ""
	}
	s := readSynced(e)
	switch {
	case s == nil:
		return true, "the list in root/ (" + sum[:12] + ") was never synced here"
	case s.List != sum:
		return true, "the list in root/ (" + sum[:12] + ") is not the one synced here (" + short(s.List) + ")"
	case s.OS != osIdentity():
		return true, "the last sync (" + s.At + ") ran on another system (" + short(s.OS) + "; a reimage or an OS upgrade)"
	case s.Result == "incomplete":
		at, err := time.Parse(time.RFC3339, s.At)
		if err != nil || now.Sub(at) >= syncRetry {
			return true, "the last sync (" + s.At + ") was incomplete: " + s.Detail
		}
	case s.Result == "blocked" && explicit:
		return true, "the last sync (" + s.At + ") needed an administrator: " + s.Detail
	}
	return false, ""
}

func short(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	if s == "" {
		return "none"
	}
	return s
}

// syncAfter (run's last step): sync when this run put root files in, or when one is pending anyway. With systemd the
// sync is a unit of its own that this run starts and does not wait for (startSync); without, it runs here, bounded.
func (u *updater) syncAfter() {
	if pending, _ := syncPending(u.e, u.e.now(), !u.scheduled); !u.rootIn && !pending {
		return
	}
	if !fileExists(u.e.root(packagesSh)) || !fileExists(u.e.root(packagesList)) {
		return
	}
	if syncAsUnit(u) {
		u.startSync()
		return
	}
	u.syncSystem(u.verified, syncInlineTimeout)
}

func syncUnit(id string) string { return id + "-packages-sync" }

// startSync starts `mycel-ctl packages-sync` as the transient unit <id>-packages-sync.service and returns at once: the
// update's result never waits for apt or a download. The unit's name keeps one sync at a time: when one runs already
// (a slow download from the last update), that one stays and the next check syncs again if the list changed meanwhile.
// It reads the list's flat copy (root/packages.flat): this run's bundle folder is gone by the time the unit runs.
func (u *updater) startSync() {
	ctl := u.e.root("mycel-ctl")
	if !fileExists(ctl) {
		if self, err := os.Executable(); err == nil {
			ctl = self
		}
	}
	unit := syncUnit(u.in.ID)
	if out, _ := exec.Command(u.e.systemctl, "is-active", unit+".service").Output(); isActive(string(out)) {
		u.res.Notes = append(u.res.Notes, "system packages: a sync runs already ("+unit+".service); the next check syncs again if the list changed")
		return
	}
	limit := int((syncTimeout + 2*syncWaitDelay) / time.Second)
	args := []string{"--unit=" + unit, "--collect", "--quiet", "--no-block", "--description=" + u.in.ID + " system packages sync",
		"--property=RuntimeMaxSec=" + fmt.Sprint(limit)}
	for _, kv := range syncEnv() {
		if !strings.HasPrefix(kv, "PATH=") && !strings.HasPrefix(kv, "HOME=") && !strings.HasPrefix(kv, "LC_ALL=") {
			args = append(args, "--setenv="+kv)
		}
	}
	args = append(args, ctl, "packages-sync", "--base", u.e.base)
	if out, err := startSyncUnit(args); err != nil {
		out = strings.TrimSpace(out)
		if strings.Contains(out, "already") {
			u.res.Notes = append(u.res.Notes, "system packages: a sync runs already ("+unit+".service)")
			return
		}
		// the record says so, so the timer tries again after syncRetry
		why := "could not start " + unit + ".service: " + err.Error()
		if out != "" {
			why += " (" + out + ")"
		}
		u.res.Notes = append(u.res.Notes, "system packages: "+why)
		u.noteSync("incomplete", why)
		return
	}
	u.res.Notes = append(u.res.Notes, "system packages: the sync runs in "+unit+".service after this update (result: mycel-ctl status)")
}

func isActive(s string) bool {
	s = strings.TrimSpace(s)
	return s == "active" || s == "activating" || s == "reloading"
}

// cmdPackagesSync is the sync's own unit (startSync; internal): packages.sh sync for the list in root/, with
// syncTimeout. One at a time (root/.packages-sync.lock): a second one ends at once. It never takes the update's lock, so
// an update meanwhile is not "busy".
func cmdPackagesSync(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("packages-sync", flag.ContinueOnError)
	e.flags(fs)
	if err := fs.Parse(args); err != nil {
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
	unlock, err := lockUpdate(e.root(".packages-sync.lock"))
	if err != nil {
		fmt.Fprintln(e.stdout, "packages-sync: another sync is running")
		return 0, nil
	}
	defer unlock()
	u := &updater{e: e, in: in, res: &UpdateResult{}}
	u.syncSystem("", syncTimeout)
	for _, n := range u.res.Notes {
		fmt.Fprintln(e.stdout, n)
	}
	return 0, nil
}

// syncSystem runs packages.sh sync, with the bun of a bundle VerifyDir accepted when the run has one (verified; else the
// list's flat copy). It runs a private copy of root/packages.{sh,json,flat}: an update that replaces root/ meanwhile
// does not change a script bash is reading, and the record names the list the sync read (the next check syncs the new
// one). It is bounded: at the timeout its process group gets SIGTERM (a download stops; apt runs as a transient unit of
// its own, systemd-run, and finishes), and nothing of it fails the update: its lines and any failure are notes. A sync
// that ends without writing root/packages.synced (stopped, or the script failed early) gets an "incomplete" record here,
// so the timer tries again after syncRetry, not at every check.
func (u *updater) syncSystem(verified string, timeout time.Duration) {
	if !fileExists(u.e.root(packagesSh)) || !fileExists(u.e.root(packagesList)) {
		return
	}
	before, _ := readRootFile(u.e.root(packagesSynced), 64<<10)
	why := ""
	if priv, err := os.MkdirTemp(u.e.root(), ".packages-sync-"); err != nil {
		why = "cannot copy " + packagesSh + ": " + err.Error()
	} else {
		defer os.RemoveAll(priv)
		why = u.runSyncScript(priv, verified, timeout)
	}
	if why != "" {
		u.res.Notes = append(u.res.Notes, "system packages: "+why)
	}
	if after, _ := readRootFile(u.e.root(packagesSynced), 64<<10); string(after) == string(before) {
		if why == "" {
			why = packagesSh + " sync ended without a result"
		}
		u.noteSync("incomplete", why)
	}
}

// runSyncScript copies the list and its reader into priv (0700) and runs the copy; "" or why it failed.
func (u *updater) runSyncScript(priv, verified string, timeout time.Duration) string {
	for _, f := range []string{packagesSh, packagesList, "packages.flat"} {
		b, err := readRootFile(u.e.root(f), 4<<20)
		if err != nil {
			if f == "packages.flat" && os.IsNotExist(err) {
				continue
			}
			return "cannot copy " + f + ": " + err.Error()
		}
		if err := os.WriteFile(filepath.Join(priv, f), b, 0o600); err != nil {
			return "cannot copy " + f + ": " + err.Error()
		}
	}
	args := []string{filepath.Join(priv, packagesSh), "sync", "--id", u.in.ID, "--base", u.e.base}
	if bun := filepath.Join(verified, "bin", "bun"); verified != "" && fileExists(bun) {
		args = append(args, "--bun", bun)
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bashPath, args...)
	cmd.Dir = "/"
	cmd.Env = syncEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = syncWaitDelay
	out, err := cmd.CombinedOutput()
	for _, l := range strings.Split(string(out), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			u.res.Notes = append(u.res.Notes, l)
		}
	}
	switch {
	case ctx.Err() == context.DeadlineExceeded:
		return fmt.Sprintf("%s sync did not finish in %v and was stopped (an apt run it started finishes by itself)", packagesSh, timeout)
	case err != nil:
		return packagesSh + " sync: " + err.Error()
	}
	return ""
}

// syncOnly ends the scheduled gate when root has no release to install now (why): with a pending sync the run goes on,
// installs nothing and syncs (run's syncOnlyRun, then syncAfter); else it is a skip. So a pending sync never makes root
// take a release the app takes by itself, and a staged roll-out or a hold does not delay the catch-up.
func (u *updater) syncOnly(why string) bool {
	u.res.Result, u.res.Skipped, u.res.Detail = "ok", true, why
	if pending, reason := syncPending(u.e, u.e.now(), false); pending {
		u.syncOnlyRun = true
		u.res.Notes = append(u.res.Notes, "system packages: "+reason)
		return true
	}
	return false
}

// noteSync writes root/packages.synced for the list in root/ (when packages.sh could not).
func (u *updater) noteSync(result, detail string) {
	sum := listSum(u.e)
	if sum == "" {
		return
	}
	b, _ := json.Marshal(SyncState{Format: 1, List: sum, Result: result, At: u.e.now().UTC().Format(time.RFC3339), Detail: detail, OS: osIdentity()})
	if err := writeRootFile(u.e.root(packagesSynced), append(b, '\n'), 0o644); err != nil {
		u.res.Notes = append(u.res.Notes, "system packages: cannot write "+packagesSynced+": "+err.Error())
	}
}

// syncEnv: a plain root environment, plus the proxy settings of this run (apt and curl read them).
func syncEnv() []string {
	env := []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C", "HOME=/root"}
	for _, k := range []string{"http_proxy", "https_proxy", "no_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// syncStatus is the line of `mycel-ctl status` (and its JSON) about the system packages.
func syncStatus(e *env, now time.Time) (string, *SyncState, bool) {
	sum := listSum(e)
	if sum == "" {
		return "", nil, false
	}
	s := readSynced(e)
	pending, why := syncPending(e, now, false)
	switch {
	case s == nil || s.List != sum || s.OS != osIdentity():
		return "not synced to the list in root/ (" + why + "); the update timer syncs in the update window, now: sudo mycel-ctl update", s, pending
	case s.Result == "ok":
		b := ""
		if s.Browser != "" {
			b = ", chrome-headless-shell " + s.Browser
		}
		return "synced " + s.At + b, s, pending
	case s.Result == "blocked":
		return "needs an administrator (" + s.Detail + ")", s, pending
	default:
		return "incomplete at " + s.At + " (" + s.Detail + "); tried again after " + syncRetry.String(), s, pending
	}
}
