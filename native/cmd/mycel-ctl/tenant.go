package main

// Tenant commands of the hosted service (control-plane 3.5.3, CT-1): what ax-hostd may run inside a tenant VM for the
// control plane, through the guest agent, as `mycel-ctl <command> --json [--<kebab-case-arg> <value>]...` with a JSON
// stdin where the command takes one. The allow-list, argument and stdin schemas and outputs are the contract in
// shared/src/cloud-protocol/tenant-commands.ts (re-exported by ee/cloud/contracts/substrate.ts); ax-hostd checks
// them before it runs anything, and these commands check again. Every command prints exactly one JSON object
// (at most 1 MiB) on success and nothing on stdout on failure (the reason goes to stderr, the exit code is not 0).
//
// Root does root things itself (notices.json, plan.json, units). App-level work runs as the SERVER ACCOUNT: the
// server's own admin CLI (`<base>/app/current/server/src/admin.js`, system/cloud-admin.ts and cloud-tenant.ts), and
// writes into folders the server account owns (config/server.json, data/relay/registration.json) are done by this
// program re-executed as that account (server-write / server-config-merge), so root never writes through a path the
// server account could have replaced with a link.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// maxStdout is the guest agent's limit for what a command prints (TENANT_STDOUT_MAX).
const maxStdout = 1 << 20

var (
	teamSlugRE   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
	relayTeamRE  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	usernameRE   = regexp.MustCompile(`^[A-Za-z0-9._@-]{2,64}$`)
	localIDRE    = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}Z-(daily|manual|pre-update|final)(-[0-9]+)?$`)
	ageRecipRE   = regexp.MustCompile(`^age1[02-9ac-hj-np-z]{58}$`)
	b64RE        = regexp.MustCompile(`^[A-Za-z0-9+/]+=*$`)
	noticeIDRE   = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)
	credKinds    = map[string]bool{"anthropic-oauth": true, "anthropic-api-key": true, "chatgpt": true, "openai-api-key": true}
	backupKinds  = map[string]bool{"daily": true, "manual": true, "pre-update": true, "final": true}
	errNoJSONOut = errors.New("the server's admin CLI did not print one JSON object")
)

// tenant is one tenant command's context: the flags every command takes, the install, the server account.
type tenant struct {
	e  *env
	in *Install
	fs *flag.FlagSet
	// hooks (tests): run admin.js, restart / signal the server, count running turns
	admin         func(stdin []byte, timeout time.Duration, args ...string) ([]byte, error)
	restart       func() (bool, error)
	serverStarted func() (time.Time, bool)
	hup           func()
	liveTurns     func() (int, error)
	sleep         func(time.Duration)
	asServerFn    func(stdin []byte, args ...string) ([]byte, error)
}

// tenantTestHook lets tests replace the parts that need a real server, launcher or systemd.
var tenantTestHook func(t *tenant)

func newTenant(e *env, name string) *tenant {
	t := &tenant{e: e, fs: flag.NewFlagSet(name, flag.ContinueOnError), sleep: time.Sleep}
	t.fs.SetOutput(e.stderr)
	e.flags(t.fs)
	t.fs.Bool("json", true, "JSON output (always)")
	return t
}

// open parses the flags, checks root and the install.
func (t *tenant) open(args []string) (int, error) {
	if err := t.fs.Parse(args); err != nil {
		return 2, usageError{err.Error()}
	}
	if t.fs.NArg() > 0 {
		return 2, usageError{"unexpected argument " + t.fs.Arg(0)}
	}
	if err := requireRoot(); err != nil {
		return 2, err
	}
	if err := checkBase(t.e.base); err != nil {
		return 1, err
	}
	in, err := loadInstall(t.e)
	if err != nil {
		return 1, err
	}
	t.in = in
	t.admin = t.runAdmin
	t.restart = t.restartServer
	t.serverStarted = t.serverStartedAtSystemd
	t.hup = t.hupServer
	t.liveTurns = func() (int, error) { return (&updater{e: t.e, in: t.in}).launcherLiveTurns() }
	t.asServerFn = t.asServerOut
	if tenantTestHook != nil {
		tenantTestHook(t)
	}
	return 0, nil
}

// out prints one JSON value (refused above 1 MiB: the guest agent would cut it).
func (t *tenant) out(v any) (int, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return 1, err
	}
	if len(b) > maxStdout {
		return 1, fmt.Errorf("output of %d bytes is over 1 MiB", len(b))
	}
	fmt.Fprintln(t.e.stdout, string(b))
	return 0, nil
}

// passOn prints what admin.js printed, after checking it is one JSON object of at most 1 MiB.
func (t *tenant) passOn(raw []byte) (int, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' || !json.Valid(raw) {
		return 1, errNoJSONOut
	}
	if len(raw) > maxStdout {
		return 1, fmt.Errorf("output of %d bytes is over 1 MiB", len(raw))
	}
	var c bytes.Buffer
	if err := json.Compact(&c, raw); err != nil {
		return 1, err
	}
	fmt.Fprintln(t.e.stdout, c.String())
	return 0, nil
}

// stdinJSON reads the command's JSON stdin (one object, at most max bytes).
func (t *tenant) stdinJSON(max int64) ([]byte, map[string]json.RawMessage, error) {
	b, err := io.ReadAll(io.LimitReader(t.e.stdin, max+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(b)) > max {
		return nil, nil, fmt.Errorf("stdin is over %d bytes", max)
	}
	var m map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil || m == nil {
		return nil, nil, fmt.Errorf("stdin must be one JSON object")
	}
	return bytes.TrimSpace(b), m, nil
}

// runAdmin runs the current app's admin.js as the server account with a fixed environment; stdout is the answer.
func (t *tenant) runAdmin(stdin []byte, timeout time.Duration, args ...string) ([]byte, error) {
	srv, err := lookupAccount(t.in.ServerUser)
	if err != nil {
		return nil, err
	}
	b := t.in.Base
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(b, "app", "current", "bin", "bun"), append([]string{filepath.Join(b, "app", "current", "server", "src", "admin.js")}, args...)...)
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + filepath.Join(b, "data"), "LANG=C.UTF-8", "MYCEL_MODE=prod",
		"MYCEL_CONFIG=" + filepath.Join(b, "config", "server.json"), "MYCEL_INSTALL_BASE=" + b, "MYCEL_LABEL=" + t.in.ID}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(srv.uid), Gid: uint32(srv.gid), Groups: []uint32{}}}
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &limitedBuffer{b: &out, max: maxStdout + 1}, &limitedBuffer{b: &errb, max: 64 << 10}
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return nil, adminExit{code: ee.ExitCode(), msg: fmt.Sprintf("admin.js %s: %v: %s", args[0], err, tailLines(errb.String(), 3))}
		}
		return nil, fmt.Errorf("admin.js %s: %v: %s", args[0], err, tailLines(errb.String(), 3))
	}
	return out.Bytes(), nil
}

// adminExit: admin.js ended with this exit code (a code a command gives on, as reset-link's 3 owner_recovery_locked).
type adminExit struct {
	code int
	msg  string
}

func (a adminExit) Error() string { return a.msg }

// errOwnerRecoveryLocked: reset-link after a handover on a hosted team with handoverSafe, until owner-recovery-claimed
// (admin.js exit 3). mycel-ctl exits 3 too, so the control plane can tell it from a failure (TENANT_COMMANDS reset-link).
var errOwnerRecoveryLocked = errors.New("owner_recovery_locked: the team changed hands; owners and admins get no reset link until the new owner claims recovery")

type limitedBuffer struct {
	b   *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.b.Len(); room > 0 {
		if len(p) > room {
			l.b.Write(p[:room])
		} else {
			l.b.Write(p)
		}
	}
	return len(p), nil
}

func tailLines(s string, n int) string {
	ls := strings.Split(strings.TrimSpace(s), "\n")
	if len(ls) > n {
		ls = ls[len(ls)-n:]
	}
	return strings.Join(ls, " | ")
}

func (t *tenant) systemd() bool { return t.in.Systemd && fileExists(systemdRunDir) }

// restartServer restarts the server unit (after a change of server.json or the relay registration).
func (t *tenant) restartServer() (bool, error) {
	if !t.systemd() {
		return false, nil
	}
	if out, err := exec.Command(t.e.systemctl, "restart", t.in.ID+"-server.service").CombinedOutput(); err != nil {
		return false, fmt.Errorf("restart server: %v %s", err, out)
	}
	return true, nil
}

// hupServer asks the server to read plan.json and notices.json again now: SIGHUP to the unit's main process (the
// bootstrap passes it to the server alone; `all` would also hit the server's helpers). Best effort: the server reads
// both files again within a minute anyway.
func (t *tenant) hupServer() {
	if t.systemd() {
		_ = exec.Command(t.e.systemctl, "kill", "--kill-whom=main", "--signal=SIGHUP", t.in.ID+"-server.service").Run()
	}
}

// asServer runs this program again as the server account (server-write / server-config-merge).
func (t *tenant) asServer(stdin []byte, args ...string) error {
	_, err := t.asServerOut(stdin, args...)
	return err
}

// asServerOut is asServer that also returns what the program printed on stdout (at most 64 KiB).
func (t *tenant) asServerOut(stdin []byte, args ...string) ([]byte, error) {
	srv, err := lookupAccount(t.in.ServerUser)
	if err != nil {
		return nil, err
	}
	self, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(self, append(args, "--base", t.e.base)...)
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	cmd.Dir = "/"
	cmd.Stdin = bytes.NewReader(stdin)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(srv.uid), Gid: uint32(srv.gid), Groups: []uint32{}}}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &limitedBuffer{b: &out, max: 64 << 10}, &limitedBuffer{b: &errb, max: 64 << 10}
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s as %s: %v %s", args[0], t.in.ServerUser, err, strings.TrimSpace(out.String()+" "+errb.String()))
	}
	return out.Bytes(), nil
}

// ---------------------------------------------------------------- the commands

// notices-set < NoticesFile: <base>/root/notices.json (root 0644), then SIGHUP.
func cmdNoticesSet(e *env, args []string) (int, error) {
	t := newTenant(e, "notices-set")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	raw, m, err := t.stdinJSON(256 << 10)
	if err != nil {
		return 1, err
	}
	if err := checkNotices(m); err != nil {
		return 1, err
	}
	if err := writeRootFile(e.root("notices.json"), append(raw, '\n'), 0o644); err != nil {
		return 1, err
	}
	t.hup()
	return t.out(map[string]bool{"ok": true})
}

// checkNotices: the shape of notices.json (ax-hostd checked the full schema; the server checks it again on read).
func checkNotices(m map[string]json.RawMessage) error {
	if string(m["format"]) != "1" {
		return fmt.Errorf("notices: format must be 1")
	}
	var list []struct {
		ID       string `json:"id"`
		Level    string `json:"level"`
		Audience string `json:"audience"`
	}
	if err := json.Unmarshal(m["notices"], &list); err != nil {
		return fmt.Errorf("notices: notices must be a list")
	}
	if len(list) > 10 {
		return fmt.Errorf("notices: at most 10")
	}
	seen := map[string]bool{}
	for _, n := range list {
		if !noticeIDRE.MatchString(n.ID) || seen[n.ID] {
			return fmt.Errorf("notices: bad or repeated id %q", n.ID)
		}
		seen[n.ID] = true
		if n.Level != "info" && n.Level != "warn" && n.Level != "critical" {
			return fmt.Errorf("notices: bad level %q", n.Level)
		}
		if n.Audience != "owner" && n.Audience != "admins" && n.Audience != "everyone" {
			return fmt.Errorf("notices: bad audience %q", n.Audience)
		}
	}
	return nil
}

// set-server-config < { relay?: { teamName }, publicOrigins?, engine?: { credentialKinds } }: those keys of
// config/server.json only (the rest is kept), then a restart.
func cmdSetServerConfig(e *env, args []string) (int, error) {
	t := newTenant(e, "set-server-config")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	raw, m, err := t.stdinJSON(64 << 10)
	if err != nil {
		return 1, err
	}
	if err := checkServerConfigPatch(m); err != nil {
		return 1, err
	}
	if _, err := t.asServerFn(raw, "server-config-merge"); err != nil {
		return 1, err
	}
	restarted, err := t.restart()
	if err != nil {
		return 1, err
	}
	return t.out(map[string]bool{"ok": true, "restarted": restarted})
}

// httpsURL: https, or http to this machine only (shared/src/cloud-protocol HttpsUrl); no user:password.
func httpsURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil || u.User != nil || u.Host == "" {
		return false
	}
	h := u.Hostname()
	local := h == "127.0.0.1" || h == "::1" || h == "localhost" || strings.HasSuffix(h, ".localhost")
	return u.Scheme == "https" || (u.Scheme == "http" && local)
}

func checkServerConfigPatch(m map[string]json.RawMessage) error {
	if len(m) == 0 {
		return fmt.Errorf("nothing to change")
	}
	for k, v := range m {
		switch k {
		case "relay":
			var r map[string]string
			if json.Unmarshal(v, &r) != nil || len(r) != 1 || len(r["teamName"]) < 3 || len(r["teamName"]) > 40 || !teamSlugRE.MatchString(r["teamName"]) {
				return fmt.Errorf("relay: only { teamName } with a valid team name")
			}
		case "publicOrigins":
			var o []string
			if json.Unmarshal(v, &o) != nil || len(o) > 10 {
				return fmt.Errorf("publicOrigins: at most 10 addresses")
			}
			for _, s := range o {
				if !httpsURL(s) {
					return fmt.Errorf("publicOrigins: %q is not https (or http to this machine)", s)
				}
			}
		case "engine":
			var en map[string][]string
			if json.Unmarshal(v, &en) != nil || len(en) != 1 || len(en["credentialKinds"]) < 1 || len(en["credentialKinds"]) > 4 {
				return fmt.Errorf("engine: only { credentialKinds } with 1-4 kinds")
			}
			for _, kd := range en["credentialKinds"] {
				if !credKinds[kd] {
					return fmt.Errorf("engine: unknown credential kind %q", kd)
				}
			}
		default:
			return fmt.Errorf("%s may not be changed", k)
		}
	}
	return nil
}

// relay-registration-set < { relayRegistration }: <data>/relay/registration.json (server account 0600), restart.
func cmdRelayRegistrationSet(e *env, args []string) (int, error) {
	t := newTenant(e, "relay-registration-set")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	_, m, err := t.stdinJSON(16 << 10)
	if err != nil {
		return 1, err
	}
	if len(m) != 1 || m["relayRegistration"] == nil {
		return 1, fmt.Errorf("stdin must be { relayRegistration }")
	}
	var r struct {
		RelayAPI  string `json:"relayApi"`
		TeamID    string `json:"teamId"`
		TeamName  string `json:"teamName"`
		PublicKey string `json:"publicKey"`
		Address   string `json:"address"`
	}
	dec := json.NewDecoder(bytes.NewReader(m["relayRegistration"]))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		return 1, fmt.Errorf("relayRegistration: %v", err)
	}
	if !httpsURL(r.RelayAPI) || !httpsURL(r.Address) || !relayTeamRE.MatchString(r.TeamID) || !teamSlugRE.MatchString(r.TeamName) ||
		len(r.PublicKey) < 40 || len(r.PublicKey) > 200 || !b64RE.MatchString(r.PublicKey) {
		return 1, fmt.Errorf("relayRegistration: a field is not valid")
	}
	file, _ := json.Marshal(r)
	if _, err := t.asServerFn(append(file, '\n'), "server-write", "--file", "data/relay/registration.json"); err != nil {
		return 1, err
	}
	if _, err := t.restart(); err != nil {
		return 1, err
	}
	return t.out(map[string]bool{"ok": true})
}

// relay-key-proof --team-id T: the relay key signs keyRotationString(T, publicKey) (admin.js relay-key).
func cmdRelayKeyProof(e *env, args []string) (int, error) {
	t := newTenant(e, "relay-key-proof")
	teamID := t.fs.String("team-id", "", "relay team id")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	if !relayTeamRE.MatchString(*teamID) {
		return 2, usageError{"--team-id"}
	}
	raw, err := t.admin(nil, 30*time.Second, "relay-key", "--sign-rotate", *teamID)
	if err != nil {
		return 1, err
	}
	var k struct {
		PublicKey string `json:"publicKey"`
		Sig       string `json:"sig"`
	}
	if json.Unmarshal(raw, &k) != nil || k.PublicKey == "" || k.Sig == "" {
		return 1, errNoJSONOut
	}
	return t.out(k)
}

// waitIdle polls the running turns until none or the deadline.
func (t *tenant) waitIdle(max time.Duration) (bool, int) {
	deadline := time.Now().Add(max)
	for {
		n, err := t.liveTurns()
		if err == nil && n == 0 {
			return true, 0
		}
		if time.Now().After(deadline) {
			if err != nil {
				n = 0
			}
			return false, n
		}
		t.sleep(2 * time.Second)
	}
}

// idle-wait --max S [--activity]: { idle, running } once no answer runs, or after S seconds. With --activity (F2 sleep)
// it adds what admin.js cloud-idle reads from status/status.json: { sleepable, idleForSec, connections,
// nextScheduleInSec }. sleepable needs no running answer here too; an admin.js failure is "not sleepable".
func cmdIdleWait(e *env, args []string) (int, error) {
	t := newTenant(e, "idle-wait")
	max := t.fs.Int("max", 600, "seconds")
	activity := t.fs.Bool("activity", false, "add the sleep facts")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	if *max < 0 || *max > 3600 {
		return 2, usageError{"--max 0-3600"}
	}
	idle, running := t.waitIdle(time.Duration(*max) * time.Second)
	if !*activity {
		return t.out(map[string]any{"idle": idle, "running": running})
	}
	o := map[string]any{"idle": idle, "running": running, "sleepable": false, "idleForSec": nil, "connections": nil, "nextScheduleInSec": nil}
	if raw, err := t.admin(nil, 15*time.Second, "cloud-idle"); err == nil {
		var a struct {
			Fresh             bool `json:"fresh"`
			Sleepable         bool `json:"sleepable"`
			IdleForSec        *int `json:"idleForSec"`
			Connections       *int `json:"connections"`
			NextScheduleInSec *int `json:"nextScheduleInSec"`
		}
		if json.Unmarshal(bytes.TrimSpace(raw), &a) == nil && a.Fresh {
			nonNeg := func(p *int) any {
				if p == nil || *p < 0 {
					return nil
				}
				return *p
			}
			o["idleForSec"], o["connections"], o["nextScheduleInSec"] = nonNeg(a.IdleForSec), nonNeg(a.Connections), nonNeg(a.NextScheduleInSec)
			o["sleepable"] = a.Sleepable && idle && running == 0 && a.IdleForSec != nil
		}
	}
	return t.out(o)
}

// prepare-stop --grace S: wait for running answers up to S seconds, then stop the server and the launcher.
func cmdPrepareStop(e *env, args []string) (int, error) {
	t := newTenant(e, "prepare-stop")
	grace := t.fs.Int("grace", 120, "seconds")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	if *grace < 0 || *grace > 3600 {
		return 2, usageError{"--grace 0-3600"}
	}
	t.waitIdle(time.Duration(*grace) * time.Second)
	if !t.systemd() {
		return t.out(map[string]bool{"stopped": false})
	}
	if out, err := exec.Command(t.e.systemctl, "stop", t.in.ID+"-server.service", t.in.ID+"-launcher.service").CombinedOutput(); err != nil {
		return 1, fmt.Errorf("stop: %v %s", err, out)
	}
	return t.out(map[string]bool{"stopped": true})
}

// backup-prepare --kind K [--local-id ID]: admin.js cloud-backup prepare.
func cmdBackupPrepare(e *env, args []string) (int, error) {
	t := newTenant(e, "backup-prepare")
	kind := t.fs.String("kind", "", "daily|manual|pre-update|final")
	localID := t.fs.String("local-id", "", "a given local backup")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	if !backupKinds[*kind] || (*localID != "" && !localIDRE.MatchString(*localID)) {
		return 2, usageError{"--kind daily|manual|pre-update|final [--local-id <local backup id>]"}
	}
	a := []string{"cloud-backup", "prepare", "--kind", *kind}
	if *localID != "" {
		a = append(a, "--local-id", *localID)
	}
	raw, err := t.admin(nil, 2*time.Hour, a...)
	if err != nil {
		return 1, err
	}
	return t.passOn(raw)
}

// backup-upload < BackupUploadInput: admin.js cloud-backup upload.
func cmdBackupUpload(e *env, args []string) (int, error) {
	return adminWithStdin(e, args, "backup-upload", 6*time.Hour, "cloud-backup", "upload")
}

// export < { partSize, partUrls }: admin.js archive --passphrase-random --upload.
func cmdExport(e *env, args []string) (int, error) {
	return adminWithStdin(e, args, "export", 6*time.Hour, "archive", "--passphrase-random", "--upload")
}

func adminWithStdin(e *env, args []string, name string, timeout time.Duration, adminArgs ...string) (int, error) {
	t := newTenant(e, name)
	if c, err := t.open(args); err != nil {
		return c, err
	}
	raw, _, err := t.stdinJSON(16 << 20) // up to 10,000 presigned part URLs
	if err != nil {
		return 1, err
	}
	out, err := t.admin(raw, timeout, adminArgs...)
	if err != nil {
		return 1, err
	}
	return t.passOn(out)
}

// reset-link --owner | --username U: { url, expiresAt } (admin.js reset-link, at publicOrigins[0]).
func cmdResetLink(e *env, args []string) (int, error) {
	t := newTenant(e, "reset-link")
	owner := t.fs.Bool("owner", false, "the owner")
	username := t.fs.String("username", "", "an account")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	if *owner == (*username != "") || (*username != "" && !usernameRE.MatchString(*username)) {
		return 2, usageError{"--owner or --username U"}
	}
	a := []string{"reset-link"}
	if *username != "" {
		a = append(a, "--username", *username)
	}
	raw, err := t.admin(nil, 30*time.Second, a...)
	if err != nil {
		var ae adminExit
		if errors.As(err, &ae) && ae.code == 3 {
			return 3, errOwnerRecoveryLocked
		}
		return 1, err
	}
	return t.passOn(raw)
}

// owner-recovery-claimed: { ok, cleared } (admin.js owner-recovery-claimed). The control plane runs it after the new
// owner of a hosted team claimed recovery (a recovery and billing contact) in its console: owner and admin reset links
// may go out again. Without a lock it changes nothing (cleared false).
func cmdOwnerRecoveryClaimed(e *env, args []string) (int, error) {
	t := newTenant(e, "owner-recovery-claimed")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	raw, err := t.admin(nil, 30*time.Second, "owner-recovery-claimed")
	if err != nil {
		return 1, err
	}
	return t.passOn(raw)
}

// setup-token-rotate: a new setup token while nobody has an account yet, then a restart.
func cmdSetupTokenRotate(e *env, args []string) (int, error) {
	t := newTenant(e, "setup-token-rotate")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	raw, err := t.admin(nil, 60*time.Second, "setup-token-rotate")
	if err != nil {
		return 1, err
	}
	var r struct {
		SetupToken string `json:"setupToken"`
	}
	if json.Unmarshal(raw, &r) != nil || r.SetupToken == "" {
		return 1, errNoJSONOut
	}
	if _, err := t.restart(); err != nil {
		return 1, err
	}
	return t.out(r)
}

// credentials-escrow-out --recipient R: { keyAge, keyVersion } | { absent: true }.
func cmdCredentialsEscrowOut(e *env, args []string) (int, error) {
	t := newTenant(e, "credentials-escrow-out")
	recipient := t.fs.String("recipient", "", "age X25519 recipient")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	if !ageRecipRE.MatchString(*recipient) {
		return 2, usageError{"--recipient age1…"}
	}
	raw, err := t.admin(nil, 30*time.Second, "credentials-escrow-out", "--recipient", *recipient)
	if err != nil {
		return 1, err
	}
	return t.passOn(raw)
}

// orKeyRE: an OpenRouter API key (shared/src/cloud-protocol OpenRouterApiKey)
var orKeyRE = regexp.MustCompile(`^sk-or-[A-Za-z0-9_-]{16,200}$`)

// hosted-speech-key-set < { key: "sk-or-…" | null }: the hosting service's speech-to-text key for this team (hosted
// voice input and video sound, the plan's free hours a month: plan.json speechFreeHours, else 10), kept by admin.js
// hosted-speech-key encrypted with the credentials vault. The key goes only on admin.js's stdin: never in an argument,
// an error or the answer { ok, set }.
// No restart: the server reads it at its next speech request.
func cmdHostedSpeechKeySet(e *env, args []string) (int, error) {
	t := newTenant(e, "hosted-speech-key-set")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	_, m, err := t.stdinJSON(4 << 10)
	if err != nil {
		return 1, err
	}
	if len(m) != 1 || m["key"] == nil {
		return 1, fmt.Errorf("stdin must be { key }")
	}
	var key *string
	if json.Unmarshal(m["key"], &key) != nil {
		return 1, fmt.Errorf("key: a string or null")
	}
	if key != nil && !orKeyRE.MatchString(*key) {
		return 1, fmt.Errorf("key: not an OpenRouter key")
	}
	in, _ := json.Marshal(map[string]*string{"key": key})
	raw, err := t.admin(in, 30*time.Second, "hosted-speech-key")
	if err != nil {
		return 1, err
	}
	var r struct {
		OK  bool  `json:"ok"`
		Set *bool `json:"set"`
	}
	if json.Unmarshal(bytes.TrimSpace(raw), &r) != nil || !r.OK || r.Set == nil {
		return 1, errNoJSONOut
	}
	return t.out(map[string]any{"ok": true, "set": *r.Set})
}

// errorReportName is the server's error report switch (server/src/system/error-reports.ts): a Sentry project key.
const errorReportName = "MYCEL_ERROR_REPORT_URL"

// sentryDsnRE: a Sentry project key, https://<public key>@<host>[:port][/<prefix>...]/<project id> (shared/src/cloud-
// protocol SentryDsn, the shape shared/src/sentry-report.ts parseDsn reads). The whole value must match: it goes on
// a line of the server's environment file, so a newline, quote, backslash, space or "=" could add other variables.
var sentryDsnRE = regexp.MustCompile(`^https://[A-Za-z0-9]{1,128}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){0,9}(:[0-9]{1,5})?(/[A-Za-z0-9_-]{1,64}){0,4}/[0-9]{1,20}$`)

// errorReportsIdleWait: how long error-reports-set waits for running answers before it restarts the server.
var errorReportsIdleWait = 60 * time.Second

// defaultsChangedAt: when /etc/default/<id> last changed: the file's mtime, or the folder's when the file is gone
// (null removed its last line; the folder's mtime then is at least the removal).
func defaultsChangedAt(id string) (time.Time, bool) {
	if st, err := os.Stat(filepath.Join(defaultsDir, id)); err == nil {
		return st.ModTime(), true
	} else if !errors.Is(err, fs.ErrNotExist) {
		return time.Time{}, false
	}
	st, err := os.Stat(defaultsDir)
	if err != nil {
		return time.Time{}, false
	}
	return st.ModTime(), true
}

// serverStartedAtSystemd: when the server unit's main process started (its MainPID's start in /proc/<pid>/stat plus
// the boot time in /proc/stat); false without systemd, without a running server or when it cannot be read.
func (t *tenant) serverStartedAtSystemd() (time.Time, bool) {
	if !t.systemd() {
		return time.Time{}, false
	}
	out, err := exec.Command(t.e.systemctl, "show", "-p", "MainPID", "--value", t.in.ID+"-server.service").Output()
	if err != nil {
		return time.Time{}, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid <= 0 {
		return time.Time{}, false
	}
	return procStartTime("/proc", pid)
}

// procStartTime reads a process's start from <proc>/<pid>/stat (field 22, clock ticks after boot; USER_HZ is 100 on
// Linux) and <proc>/stat (btime, the boot time in seconds).
func procStartTime(proc string, pid int) (time.Time, bool) {
	b, err := os.ReadFile(filepath.Join(proc, strconv.Itoa(pid), "stat"))
	if err != nil {
		return time.Time{}, false
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return time.Time{}, false
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 20 {
		return time.Time{}, false
	}
	ticks, err := strconv.ParseInt(f[19], 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	st, err := os.ReadFile(filepath.Join(proc, "stat"))
	if err != nil {
		return time.Time{}, false
	}
	for _, l := range strings.Split(string(st), "\n") {
		if v, ok := strings.CutPrefix(l, "btime "); ok {
			bt, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			if err != nil {
				return time.Time{}, false
			}
			return time.Unix(bt, 0).Add(time.Duration(ticks) * 10 * time.Millisecond), true
		}
	}
	return time.Time{}, false
}

// error-reports-set < { url: "<Sentry key>" | null }: the hosting service's error report key for this team server,
// one MYCEL_ERROR_REPORT_URL line in /etc/default/<id> (the server unit's environment; every other line stays). null
// takes the line away. The same value again changes nothing (changed false), so the hosting service may send it as
// often as it likes, for example after a reimage wrote the file again. The server is restarted, once no answer has
// run for up to 60 s, on a change or when it started before the file last changed (an earlier call found it busy);
// otherwise restarted is false and the server reads it at its next start or the next resend.
// The key is never in an argument, an error or the answer { ok, changed, restarted }.
func cmdErrorReportsSet(e *env, args []string) (int, error) {
	t := newTenant(e, "error-reports-set")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	_, m, err := t.stdinJSON(4 << 10)
	if err != nil {
		return 1, err
	}
	if len(m) != 1 || m["url"] == nil {
		return 1, fmt.Errorf("stdin must be { url }")
	}
	var url *string
	if json.Unmarshal(m["url"], &url) != nil {
		return 1, fmt.Errorf("url: a string or null")
	}
	if url != nil && (len(*url) > 1000 || !sentryDsnRE.MatchString(*url)) {
		return 1, fmt.Errorf("url: not a Sentry project key")
	}
	changed, err := setDefaultsLine(t.in.ID, errorReportName, url)
	if err != nil {
		return 1, fmt.Errorf("/etc/default/%s: %v", t.in.ID, err)
	}
	return t.out(map[string]any{"ok": true, "changed": changed, "restarted": t.restartForDefaults("error-reports-set", changed)})
}

// restartForDefaults restarts the server after a change of /etc/default/<id>, once no answer has run for up to
// errorReportsIdleWait. Also without a change when the running server started before the file's last change (an
// earlier call found it busy, or another writer changed the file): it still runs with the old values. Busy or a failed
// restart: false (the server reads the file at its next start, or at the next resend).
func (t *tenant) restartForDefaults(cmd string, changed bool) bool {
	stale := false
	if !changed {
		if started, ok := t.serverStarted(); ok {
			if at, ok := defaultsChangedAt(t.in.ID); ok && started.Before(at) {
				stale = true
			}
		}
	}
	if !changed && !stale {
		return false
	}
	if idle, running := t.waitIdle(errorReportsIdleWait); !idle {
		fmt.Fprintf(t.e.stderr, "%s: %d answers still running, the server reads the change at its next start\n", cmd, running)
		return false
	}
	restarted, err := t.restart()
	if err != nil {
		fmt.Fprintf(t.e.stderr, "%s: %v; the server reads the change at its next start\n", cmd, err)
		return false
	}
	return restarted
}

// The room email mail service (server/src/rooms/apps/mail/client.ts mailInConfig): two lines of /etc/default/<id>.
const (
	mailInURLName    = "MYCEL_MAIL_IN_URL"
	mailInDomainName = "MYCEL_MAIL_IN_DOMAIN"
)

// mailInOriginRE and mailInDomainRE: the contract's MailInOrigin and MailInDomain (shared/src/cloud-protocol
// tenant-commands.ts). The whole value must match: it goes on a line of the server's environment file.
var (
	mailInOriginRE = regexp.MustCompile(`^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){1,9}(?::[0-9]{1,5})?$`)
	mailInDomainRE = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,9}[a-z]{2,63}$`)
)

// mail-in-set < { url, domain } | { url: null, domain: null }: the hosting service's mail service for room email
// (docs/runbooks/room-email-mailbox.md), the MYCEL_MAIL_IN_URL and MYCEL_MAIL_IN_DOMAIN lines of /etc/default/<id>
// (every other line stays). Both null take both lines away. The same values again change nothing (changed false). The
// server is restarted as for error-reports-set. The answer is { ok, changed, restarted }.
func cmdMailInSet(e *env, args []string) (int, error) {
	t := newTenant(e, "mail-in-set")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	_, m, err := t.stdinJSON(4 << 10)
	if err != nil {
		return 1, err
	}
	if len(m) != 2 || m["url"] == nil || m["domain"] == nil {
		return 1, fmt.Errorf("stdin must be { url, domain }")
	}
	var url, domain *string
	if json.Unmarshal(m["url"], &url) != nil || json.Unmarshal(m["domain"], &domain) != nil {
		return 1, fmt.Errorf("url, domain: strings, or both null")
	}
	if (url == nil) != (domain == nil) {
		return 1, fmt.Errorf("url and domain: both, or both null")
	}
	if url != nil && (len(*url) > 300 || !mailInOriginRE.MatchString(*url)) {
		return 1, fmt.Errorf("url: not https://<lower-case host>[:port]")
	}
	if domain != nil && (len(*domain) > 253 || !mailInDomainRE.MatchString(*domain)) {
		return 1, fmt.Errorf("domain: not a lower-case DNS name")
	}
	c1, err := setDefaultsLine(t.in.ID, mailInURLName, url)
	if err != nil {
		return 1, fmt.Errorf("/etc/default/%s: %v", t.in.ID, err)
	}
	c2, err := setDefaultsLine(t.in.ID, mailInDomainName, domain)
	if err != nil {
		return 1, fmt.Errorf("/etc/default/%s: %v", t.in.ID, err)
	}
	changed := c1 || c2
	return t.out(map[string]any{"ok": true, "changed": changed, "restarted": t.restartForDefaults("mail-in-set", changed)})
}

// githubAppFile: where the server reads its GitHub App (server/src/integrations/github/app.ts githubAppFile, the
// Linux layout's <base>/secrets), relative to the base.
const githubAppFile = "secrets/integrations/github/app.json"

// The GitHub App's values (shared/src/cloud-protocol GitHubAppFile). app.ts reads the same names with rules at least
// this wide; the secret is printable ASCII without spaces, so the file (written without HTML escapes) stays below
// app.ts's 16 KiB.
var (
	githubClientIDRE = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	githubSecretRE   = regexp.MustCompile(`^[!-~]+$`) // and at most 4096 (Go's regexp repeats at most 1000)
	githubSlugRE     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,99}$`)
)

// githubApp is the file's shape (field order fixed, so the same values always give the same bytes).
type githubApp struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	Slug         string `json:"slug,omitempty"`
}

// parseGitHubApp checks one GitHubAppFile: exactly these keys, each a string that matches its rule.
func parseGitHubApp(m map[string]json.RawMessage) (githubApp, error) {
	var a githubApp
	for k := range m {
		if k != "clientId" && k != "clientSecret" && k != "slug" {
			return a, fmt.Errorf("stdin must be { clientId, clientSecret, slug? }")
		}
	}
	str := func(k string) (string, bool) {
		var v string
		raw, ok := m[k]
		return v, ok && json.Unmarshal(raw, &v) == nil
	}
	var ok bool
	if a.ClientID, ok = str("clientId"); !ok || !githubClientIDRE.MatchString(a.ClientID) {
		return a, fmt.Errorf("clientId: not a GitHub App client ID")
	}
	if a.ClientSecret, ok = str("clientSecret"); !ok || len(a.ClientSecret) > 4096 || !githubSecretRE.MatchString(a.ClientSecret) {
		return a, fmt.Errorf("clientSecret: 1 to 4096 printable characters without spaces")
	}
	if _, has := m["slug"]; has {
		if a.Slug, ok = str("slug"); !ok || !githubSlugRE.MatchString(a.Slug) {
			return a, fmt.Errorf("slug: not a GitHub App name")
		}
	}
	return a, nil
}

// github-app-set < { clientId, clientSecret, slug? }: the hosting service's GitHub App for this team server's GitHub
// connector, written to <base>/secrets/integrations/github/app.json by the server account (file 0600, folder 0700,
// replaced atomically, never through a link). The server reads the file at each request: no restart. The same values
// again change nothing (changed false), so the hosting service may send it as often as it likes.
// The secret is never in an argument, an error or the answer { ok, changed }.
func cmdGitHubAppSet(e *env, args []string) (int, error) {
	t := newTenant(e, "github-app-set")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	// 32 KiB: a secret of 4096 characters is up to six times that once escaped (\u003c)
	_, m, err := t.stdinJSON(32 << 10)
	if err != nil {
		return 1, err
	}
	app, err := parseGitHubApp(m)
	if err != nil {
		return 1, err
	}
	// no HTML escaping (json.Marshal writes < > & as 6 bytes each): the file stays below app.ts's 16 KiB
	var file bytes.Buffer
	enc := json.NewEncoder(&file)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(app); err != nil {
		return 1, err
	}
	if file.Len() > 16<<10 {
		return 1, fmt.Errorf("the app file would be over 16 KiB")
	}
	raw, err := t.asServerFn(file.Bytes(), "server-write", "--file", githubAppFile)
	if err != nil {
		return 1, err
	}
	var r struct {
		Changed *bool `json:"changed"`
	}
	if json.Unmarshal(bytes.TrimSpace(raw), &r) != nil || r.Changed == nil {
		return 1, fmt.Errorf("server-write did not say whether the file changed")
	}
	return t.out(struct {
		OK      bool `json:"ok"`
		Changed bool `json:"changed"`
	}{true, *r.Changed})
}

// microsoftAppFile: where the server reads its Microsoft app (server/src/integrations/microsoft/app.ts
// microsoftAppFile), relative to the base.
const microsoftAppFile = "secrets/integrations/microsoft/app.json"

// The Microsoft app's values (shared/src/cloud-protocol MicrosoftAppFile): a GUID client ID, a secret of printable
// ASCII without spaces, and an optional tenant (common, organizations or a directory's GUID; no personal accounts). app.ts reads
// the same names with the same rules.
var (
	microsoftGUIDRE   = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	microsoftTenantRE = regexp.MustCompile(`^(common|organizations|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$`)
)

// microsoftApp is the file's shape (field order fixed, so the same values always give the same bytes).
type microsoftApp struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	Tenant       string `json:"tenant,omitempty"`
}

// parseMicrosoftApp checks one MicrosoftAppFile: exactly these keys, each a string that matches its rule.
func parseMicrosoftApp(m map[string]json.RawMessage) (microsoftApp, error) {
	var a microsoftApp
	for k := range m {
		if k != "clientId" && k != "clientSecret" && k != "tenant" {
			return a, fmt.Errorf("stdin must be { clientId, clientSecret, tenant? }")
		}
	}
	str := func(k string) (string, bool) {
		var v string
		raw, ok := m[k]
		return v, ok && json.Unmarshal(raw, &v) == nil
	}
	var ok bool
	if a.ClientID, ok = str("clientId"); !ok || !microsoftGUIDRE.MatchString(a.ClientID) {
		return a, fmt.Errorf("clientId: not a Microsoft application (client) ID")
	}
	if a.ClientSecret, ok = str("clientSecret"); !ok || len(a.ClientSecret) > 4096 || !githubSecretRE.MatchString(a.ClientSecret) {
		return a, fmt.Errorf("clientSecret: 1 to 4096 printable characters without spaces")
	}
	if _, has := m["tenant"]; has {
		if a.Tenant, ok = str("tenant"); !ok || !microsoftTenantRE.MatchString(a.Tenant) {
			return a, fmt.Errorf("tenant: common, organizations or a directory ID")
		}
	}
	return a, nil
}

// microsoft-app-set < { clientId, clientSecret, tenant? }: the hosting service's Microsoft app for this team server's
// Microsoft 365 connector, written like github-app-set's file (server account, 0600, folder 0700, atomic, never
// through a link) to <base>/secrets/integrations/microsoft/app.json. No restart; the same values again change nothing.
// The secret is never in an argument, an error or the answer { ok, changed }.
func cmdMicrosoftAppSet(e *env, args []string) (int, error) {
	t := newTenant(e, "microsoft-app-set")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	_, m, err := t.stdinJSON(32 << 10)
	if err != nil {
		return 1, err
	}
	app, err := parseMicrosoftApp(m)
	if err != nil {
		return 1, err
	}
	return writeServerAppFile(t, microsoftAppFile, app)
}

// writeServerAppFile writes one app file through server-write (as github-app-set) and answers { ok, changed }.
func writeServerAppFile(t *tenant, target string, app any) (int, error) {
	var file bytes.Buffer
	enc := json.NewEncoder(&file)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(app); err != nil {
		return 1, err
	}
	if file.Len() > 16<<10 {
		return 1, fmt.Errorf("the app file would be over 16 KiB")
	}
	raw, err := t.asServerFn(file.Bytes(), "server-write", "--file", target)
	if err != nil {
		return 1, err
	}
	var r struct {
		Changed *bool `json:"changed"`
	}
	if json.Unmarshal(bytes.TrimSpace(raw), &r) != nil || r.Changed == nil {
		return 1, fmt.Errorf("server-write did not say whether the file changed")
	}
	return t.out(struct {
		OK      bool `json:"ok"`
		Changed bool `json:"changed"`
	}{true, *r.Changed})
}

// ---------------------------------------------------------------- as the server account

// serverWriteTarget: a file server-write may replace, its mode, and its folder's mode (0 = leave an existing folder's
// mode as it is).
type serverWriteTarget struct{ mode, dirMode os.FileMode }

// serverWriteTargets: the only files server-write may replace (relative to the base).
var serverWriteTargets = map[string]serverWriteTarget{
	"data/relay/registration.json": {mode: 0o600},
	githubAppFile:                  {mode: 0o600, dirMode: 0o700},
	microsoftAppFile:               {mode: 0o600, dirMode: 0o700},
}

// cmdServerWrite (internal, run as the server account by asServer): replace one allowed file atomically with stdin.
// Prints {"changed":false} and writes nothing when the file already holds these bytes with its mode, else
// {"changed":true}. Never prints what it writes.
func cmdServerWrite(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("server-write", flag.ContinueOnError)
	e.flags(fs)
	file := fs.String("file", "", "relative path")
	if err := fs.Parse(args); err != nil {
		return 2, usageError{err.Error()}
	}
	tg, ok := serverWriteTargets[*file]
	if !ok || os.Geteuid() == 0 {
		return 2, usageError{"internal: an allowed file, as the server account"}
	}
	b, err := io.ReadAll(io.LimitReader(e.stdin, 1<<20))
	if err != nil {
		return 1, err
	}
	p := filepath.Join(e.base, *file)
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return 1, err
	}
	if tg.dirMode != 0 {
		var st unix.Stat_t
		if err := unix.Lstat(dir, &st); err != nil {
			return 1, err
		}
		if st.Mode&unix.S_IFMT != unix.S_IFDIR {
			return 1, fmt.Errorf("%s is not a folder", dir)
		}
		if os.FileMode(st.Mode&0o7777) != tg.dirMode {
			if err := os.Chmod(dir, tg.dirMode); err != nil {
				return 1, err
			}
		}
	}
	if cur, err := readOwnFile(p, 1<<20); err == nil && bytes.Equal(cur, b) {
		var st unix.Stat_t
		if unix.Lstat(p, &st) == nil && os.FileMode(st.Mode&0o7777) == tg.mode && st.Nlink == 1 {
			fmt.Fprintln(e.stdout, `{"changed":false}`)
			return 0, nil
		}
	}
	if err := writeOwnFile(p, b, tg.mode); err != nil {
		return 1, err
	}
	fmt.Fprintln(e.stdout, `{"changed":true}`)
	return 0, nil
}

// cmdServerConfigMerge (internal, as the server account): merge the checked patch into config/server.json, keeping
// every other key (numbers as written).
func cmdServerConfigMerge(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("server-config-merge", flag.ContinueOnError)
	e.flags(fs)
	if err := fs.Parse(args); err != nil {
		return 2, usageError{err.Error()}
	}
	if os.Geteuid() == 0 {
		return 2, usageError{"internal: as the server account"}
	}
	p := filepath.Join(e.base, "config", "server.json")
	cur, err := readOwnFile(p, 256<<10)
	if err != nil {
		return 1, err
	}
	var cfg map[string]any
	dec := json.NewDecoder(bytes.NewReader(cur))
	dec.UseNumber()
	if err := dec.Decode(&cfg); err != nil || cfg == nil {
		return 1, fmt.Errorf("server.json is not a JSON object")
	}
	var patch map[string]any
	dec = json.NewDecoder(io.LimitReader(e.stdin, 64<<10))
	dec.UseNumber()
	if err := dec.Decode(&patch); err != nil {
		return 1, err
	}
	if err := checkServerConfigPatch(rawMap(patch)); err != nil {
		return 1, err
	}
	sub := func(k string) map[string]any {
		if m, ok := cfg[k].(map[string]any); ok {
			return m
		}
		m := map[string]any{}
		cfg[k] = m
		return m
	}
	if r, ok := patch["relay"].(map[string]any); ok {
		sub("relay")["teamName"] = r["teamName"]
	}
	if o, ok := patch["publicOrigins"]; ok {
		cfg["publicOrigins"] = o
	}
	if en, ok := patch["engine"].(map[string]any); ok {
		sub("engine")["credentialKinds"] = en["credentialKinds"]
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return 1, err
	}
	var st unix.Stat_t
	mode := os.FileMode(0o600)
	if unix.Lstat(p, &st) == nil {
		mode = os.FileMode(st.Mode & 0o777)
	}
	return 0, writeOwnFile(p, append(out, '\n'), mode)
}

func rawMap(m map[string]any) map[string]json.RawMessage {
	r := map[string]json.RawMessage{}
	for k, v := range m {
		b, _ := json.Marshal(v)
		r[k] = b
	}
	return r
}

// readOwnFile / writeOwnFile: the server account's own files, never through a link at the last component.
func readOwnFile(p string, max int64) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return nil, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Size > max {
		return nil, fmt.Errorf("%s is not a small regular file", p)
	}
	return io.ReadAll(io.LimitReader(f, max))
}

func writeOwnFile(p string, b []byte, mode os.FileMode) error {
	tmp := filepath.Join(filepath.Dir(p), fmt.Sprintf(".%s.%d.tmp", filepath.Base(p), time.Now().UnixNano()))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode)
	if err != nil {
		return err
	}
	_, werr := f.Write(b)
	if werr == nil {
		werr = f.Chmod(mode)
	}
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(tmp, p)
	}
	if werr != nil {
		os.Remove(tmp)
	}
	return werr
}
