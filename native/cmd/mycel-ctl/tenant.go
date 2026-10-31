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
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
	admin      func(stdin []byte, timeout time.Duration, args ...string) ([]byte, error)
	restart    func() (bool, error)
	hup        func()
	liveTurns  func() (int, error)
	sleep      func(time.Duration)
	asServerFn func(stdin []byte, args ...string) error
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
	t.hup = t.hupServer
	t.liveTurns = func() (int, error) { return (&updater{e: t.e, in: t.in}).launcherLiveTurns() }
	t.asServerFn = t.asServer
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
		return nil, fmt.Errorf("admin.js %s: %v: %s", args[0], err, tailLines(errb.String(), 3))
	}
	return out.Bytes(), nil
}

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
	srv, err := lookupAccount(t.in.ServerUser)
	if err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(self, append(args, "--base", t.e.base)...)
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	cmd.Dir = "/"
	cmd.Stdin = bytes.NewReader(stdin)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(srv.uid), Gid: uint32(srv.gid), Groups: []uint32{}}}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s as %s: %v %s", args[0], t.in.ServerUser, err, strings.TrimSpace(string(out)))
	}
	return nil
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
	if err := t.asServerFn(raw, "server-config-merge"); err != nil {
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
	if err := t.asServerFn(append(file, '\n'), "server-write", "--file", "data/relay/registration.json"); err != nil {
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

// ---------------------------------------------------------------- as the server account

// serverWriteTargets: the only files server-write may replace (relative to the base).
var serverWriteTargets = map[string]os.FileMode{"data/relay/registration.json": 0o600}

// cmdServerWrite (internal, run as the server account by asServer): replace one allowed file atomically with stdin.
func cmdServerWrite(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("server-write", flag.ContinueOnError)
	e.flags(fs)
	file := fs.String("file", "", "relative path")
	if err := fs.Parse(args); err != nil {
		return 2, usageError{err.Error()}
	}
	mode, ok := serverWriteTargets[*file]
	if !ok || os.Geteuid() == 0 {
		return 2, usageError{"internal: an allowed file, as the server account"}
	}
	b, err := io.ReadAll(io.LimitReader(e.stdin, 1<<20))
	if err != nil {
		return 1, err
	}
	p := filepath.Join(e.base, *file)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return 1, err
	}
	return 0, writeOwnFile(p, b, mode)
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
