package main

// The system packages and programs of the one list (scripts/system/packages.json, docs/DECISIONS.md "One list of system
// packages"). Every bundle since the list came has root/packages.json, its flat copy root/packages.flat and its reader
// root/packages.sh; `packages.sh sync` brings the machine to them (missing packages, the pinned browser) and writes
// root/packages.synced: the sha256 of the list it synced to and the result.
//
// When it runs: after an update's root files and app (run's deferred syncAfter: apt or a download never holds up the
// app), and whenever root/packages.synced does not match root/packages.json. That second case is how a server catches
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
	// bashPath runs packages.sh; syncTimeout bounds a whole sync, syncRetry spaces the tries of an incomplete one
	// (variables for the tests)
	bashPath    = "/bin/bash"
	syncTimeout = 20 * time.Minute
	syncRetry   = 6 * time.Hour
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

// syncPending: is a sync root's work now, and why. Only with the list and its reader in root/.
func syncPending(e *env, now time.Time) (bool, string) {
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
	case s.Result == "incomplete":
		at, err := time.Parse(time.RFC3339, s.At)
		if err != nil || now.Sub(at) >= syncRetry {
			return true, "the last sync (" + s.At + ") was incomplete: " + s.Detail
		}
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

// syncAfter (run's last step): sync when this run put root files in, or when one is pending anyway.
func (u *updater) syncAfter(dir string) {
	if pending, _ := syncPending(u.e, u.e.now()); u.rootIn || pending {
		u.syncSystem(dir)
	}
}

// syncSystem runs root/packages.sh sync, with the verified bundle's bun when the run has one (else the list's flat
// copy). It is bounded: at syncTimeout its process group gets SIGTERM (a download stops; apt and dpkg, in a session of
// their own, finish), and nothing of it fails the update: its lines and any failure are notes.
func (u *updater) syncSystem(dir string) {
	sh := u.e.root(packagesSh)
	if !fileExists(sh) || !fileExists(u.e.root(packagesList)) {
		return
	}
	args := []string{sh, "sync", "--id", u.in.ID, "--base", u.e.base}
	if bun := filepath.Join(dir, "bin", "bun"); dir != "" && fileExists(bun) {
		args = append(args, "--bun", bun)
	}
	ctx, cancel := context.WithTimeout(context.Background(), syncTimeout)
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
		u.res.Notes = append(u.res.Notes, fmt.Sprintf("system packages: %s sync did not finish in %v and was stopped (an apt run it started finishes by itself); the next run tries again", packagesSh, syncTimeout))
	case err != nil:
		u.res.Notes = append(u.res.Notes, "system packages: "+packagesSh+" sync: "+err.Error())
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
	pending, why := syncPending(e, now)
	switch {
	case s == nil || s.List != sum:
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
