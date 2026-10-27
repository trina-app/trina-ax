package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// defaultUnits: the kit's units (linux-runtime §3.2, id "mycel"). Image mode leaves them disabled; enroll starts them.
var defaultUnits = []string{"mycel-firewall.timer", "mycel-launcher.service", "mycel-server.service"}

// credential kinds (credentials.md D2/D22): the cloud gets all four like a self-installed server (owner's decision
// 2026-10-22; shared/src/cloud-protocol CLOUD_DEFAULT_CREDENTIAL_KINDS). Subscription kinds still need the D23 notice.
var (
	cloudCredentialKinds = []string{"anthropic-oauth", "anthropic-api-key", "chatgpt", "openai-api-key"}
	allCredentialKinds   = []string{"anthropic-oauth", "anthropic-api-key", "chatgpt", "openai-api-key"}
)

// Paths are every file location the program touches, so tests can point them into a temp folder.
type Paths struct {
	EnrollFile        string // /run/ax/enroll.json
	StatusFile        string // /run/ax/enroll-status.json
	Base              string // /var/lib/mycel
	Seed              string // /usr/lib/mycel/seed-base
	DefaultFile       string // /etc/default/mycel
	CloudInitDisabled string // /etc/cloud/cloud-init.disabled
	ServerUser        string // axserver
}

type Options struct {
	Standalone bool
	NoStart    bool
	DataDevice string // auto | none | /dev/...
	Units      []string
}

// Enroller holds the configuration and every outside effect (commands, HTTP, clock, ownership), injected for tests.
type Enroller struct {
	P             Paths
	O             Options
	Run           Runner
	HTTP          *http.Client
	Now           func() time.Time
	Sleep         func(time.Duration)
	IsMountpoint  func(string) bool
	Systemd       bool
	LookupUser    func(string) (uid, gid int, err error)
	Chown         func(path string, uid, gid int) error
	Getenv        func(string) string
	Out           io.Writer
	RetryDeadline time.Duration
	// StatusHook (tests) sees every status written
	StatusHook func(statusFile)

	cfg        *EnrollFile
	kitVersion string
	step       string
	srvUID     int
	srvGID     int
}

// EnrollFile is /run/ax/enroll.json (ee/cloud/contracts/substrate.ts EnrollFile).
type EnrollFile struct {
	V                         int     `json:"v"`
	TenantID                  string  `json:"tenantId"`
	ControlPlane              string  `json:"controlPlane"`
	EnrollToken               *string `json:"enrollToken"`
	Mode                      string  `json:"mode"`
	TeamSlug                  *string `json:"teamSlug"`
	RelayTeamID               *string `json:"relayTeamId"`
	TimeZone                  string  `json:"timeZone"`
	Locale                    string  `json:"locale"`
	BackupWindowStartMin      int     `json:"backupWindowStartMin"`
	MaintenanceWindowStartMin int     `json:"maintenanceWindowStartMin"`
}

// failure is a step failure with the machine-readable code written to the status file.
type failure struct {
	Code string
	Msg  string
}

func (f *failure) Error() string { return f.Code + ": " + f.Msg }

func fail(code, format string, a ...any) error {
	return &failure{Code: code, Msg: fmt.Sprintf(format, a...)}
}

var (
	ulidRE     = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)
	tokenRE    = regexp.MustCompile(`^ent_[A-Za-z0-9_-]{16,128}$`)
	slugRE     = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	teamIDRE   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	tzRE       = regexp.MustCompile(`^(?:UTC|[A-Za-z]+(?:/[A-Za-z0-9_+-]+){1,2})$`)
	localeRE   = regexp.MustCompile(`^[a-z]{2}(?:-[A-Z]{2})?$`)
	safeNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

// Main runs the whole flow and records the result in the status file. The returned error is for the exit code and
// the journal; the status file has the same information for ax-hostd.
func (e *Enroller) Main() error {
	if e.O.Standalone {
		return e.standalone()
	}
	mode := "new"
	err := e.cloud(&mode)
	if err != nil {
		var f *failure
		if !errors.As(err, &f) {
			f = &failure{Code: "internal", Msg: err.Error()}
		}
		e.writeStatus("failed", mode, f, nil)
		return fmt.Errorf("step %s: %w", e.step, err)
	}
	return nil
}

func (e *Enroller) cloud(mode *string) error {
	e.setStep("read-config", *mode)
	cfg, err := e.readConfig()
	if err != nil {
		return err
	}
	e.cfg = cfg
	*mode = cfg.Mode

	e.setStep("data-disk", *mode)
	if err := e.dataDisk(cfg.Mode == "reattach", false); err != nil {
		return err
	}
	if err := e.serverAccount(); err != nil {
		return err
	}

	if cfg.Mode == "reattach" {
		// the data disk carries the whole install (app, root, config, secrets, relay key): only the OS-disk side
		// (/etc/default/mycel, enabled units, cloud-init) has to be put back. No token, no control plane call.
		if !exists(filepath.Join(e.P.Base, "root", "VERSION")) {
			return fail("kit_incomplete", "reattach: %s holds no install (root/VERSION missing)", e.P.Base)
		}
		e.kitVersion = e.readKitVersion()
		e.setStep("apply", *mode)
		if err := e.writeDefaults(); err != nil {
			return err
		}
		e.setStep("start", *mode)
		if err := e.start(); err != nil {
			return err
		}
		return e.finish(*mode, nil)
	}

	e.setStep("seed", *mode)
	if err := e.seed(); err != nil {
		return err
	}

	var relay *relayKey
	if cfg.Mode != "verify" {
		e.setStep("relay-key", *mode)
		if relay, err = e.relayKey(); err != nil {
			return err
		}
	}

	e.setStep("enroll", *mode)
	var oneTime *oneTimeIdentity
	if cfg.Mode == "restore" || cfg.Mode == "verify" {
		if oneTime, err = newOneTimeIdentity(); err != nil {
			return fail("internal", "age identity: %v", err)
		}
	}
	resp, err := e.enroll(relay, oneTime)
	if err != nil {
		return err
	}

	e.setStep("apply", *mode)
	var verify *verifyResult
	if cfg.Mode == "verify" {
		if verify, err = e.verifyRestore(resp, oneTime); err != nil {
			return err
		}
		return e.finish(*mode, verify)
	}
	if err := e.apply(resp); err != nil {
		return err
	}
	if cfg.Mode == "restore" {
		if err := e.restore(resp, oneTime); err != nil {
			return err
		}
	}

	e.setStep("start", *mode)
	if err := e.start(); err != nil {
		return err
	}
	return e.finish(*mode, nil)
}

func (e *Enroller) finish(mode string, v *verifyResult) error {
	e.setStep("done", mode)
	// the token is single-use and the file is on tmpfs anyway; ax-hostd removes the snippet and the cloud-init drive
	_ = os.Remove(e.P.EnrollFile)
	e.writeStatus("ok", mode, nil, v)
	fmt.Fprintf(e.Out, "mycel-enroll: %s done (kit %s)\n", mode, orDash(e.kitVersion))
	return nil
}

func (e *Enroller) setStep(step, mode string) {
	e.step = step
	e.writeStatus("running", mode, nil, nil)
}

// ---------- read-config ----------

func (e *Enroller) readConfig() (*EnrollFile, error) {
	b, err := os.ReadFile(e.P.EnrollFile)
	if err != nil {
		return nil, fail("config_invalid", "cannot read %s: %v", e.P.EnrollFile, err)
	}
	var c EnrollFile
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, fail("config_invalid", "%s: %v", e.P.EnrollFile, err)
	}
	switch {
	case c.V != 1:
		return nil, fail("config_invalid", "unsupported enroll.json version %d", c.V)
	case !ulidRE.MatchString(c.TenantID):
		return nil, fail("config_invalid", "tenantId is not a ULID")
	case c.Mode != "new" && c.Mode != "restore" && c.Mode != "verify" && c.Mode != "reattach":
		return nil, fail("config_invalid", "unknown mode %q", c.Mode)
	case (c.Mode == "reattach") != (c.EnrollToken == nil):
		return nil, fail("config_invalid", "enrollToken must be null exactly for mode reattach")
	case c.EnrollToken != nil && !tokenRE.MatchString(*c.EnrollToken):
		return nil, fail("config_invalid", "enrollToken has the wrong form")
	case c.Mode == "new" && (c.TeamSlug == nil || !slugRE.MatchString(*c.TeamSlug)):
		return nil, fail("config_invalid", "mode new needs a teamSlug")
	case c.Mode == "restore" && (c.RelayTeamID == nil || !teamIDRE.MatchString(*c.RelayTeamID)):
		return nil, fail("config_invalid", "mode restore needs relayTeamId")
	case !tzRE.MatchString(c.TimeZone):
		return nil, fail("config_invalid", "timeZone is not an IANA name")
	case !localeRE.MatchString(c.Locale):
		return nil, fail("config_invalid", "bad locale")
	case c.BackupWindowStartMin < 0 || c.BackupWindowStartMin > 1439 || c.MaintenanceWindowStartMin < 0 || c.MaintenanceWindowStartMin > 1439:
		return nil, fail("config_invalid", "window start minutes must be 0..1439")
	}
	if c.Mode != "reattach" {
		if err := e.checkURL(c.ControlPlane); err != nil {
			return nil, err
		}
	}
	return &c, nil
}

// checkURL: https, or http only to a loopback host or with AX_ENROLL_ALLOW_HTTP=1 (the docker dev driver).
func (e *Enroller) checkURL(raw string) error {
	u, err := parseURL(raw)
	if err != nil {
		return fail("config_invalid", "bad URL %q", raw)
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme == "http" && (isLoopbackHost(u.Hostname()) || e.Getenv("AX_ENROLL_ALLOW_HTTP") == "1") {
		return nil
	}
	return fail("insecure_url", "%s: only https:// is accepted (http:// only to this machine or with AX_ENROLL_ALLOW_HTTP=1)", u.Redacted())
}

// ---------- seed ----------

// seed copies the kit the template build staged on the OS disk into an empty BASE (a new data disk). An existing install
// (root/VERSION present: a retried enroll, a self-host that installed directly) is left alone.
func (e *Enroller) seed() error {
	if exists(filepath.Join(e.P.Base, "root", "VERSION")) {
		e.kitVersion = e.readKitVersion()
		return nil
	}
	if !exists(filepath.Join(e.P.Seed, "root", "VERSION")) {
		return fail("kit_incomplete", "no Team AX install in %s and no seed in %s (the image was built without the kit)", e.P.Base, e.P.Seed)
	}
	// cp -a keeps owners, modes, links and times (the seed was made by the kit installer with the fixed uids)
	if _, err := e.Run.Run(context.Background(), "cp", []string{"-a", e.P.Seed + "/.", e.P.Base + "/"}, nil); err != nil {
		return fail("seed_failed", "copy the kit into %s: %v", e.P.Base, err)
	}
	e.kitVersion = e.readKitVersion()
	return nil
}

func (e *Enroller) readKitVersion() string {
	b, err := os.ReadFile(filepath.Join(e.P.Base, "root", "VERSION"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// appVersion is the app the kit installed (app/current -> versions/<v>). A kit without the app link (the dev tenant
// image, an image built before the app was staged) reports the kit's own version: the app ships in the kit, and the
// control plane takes the value as information only (shared/src/cloud-protocol EnrollRequest; an empty string would
// read as "unknown").
func (e *Enroller) appVersion() string {
	if t, err := os.Readlink(filepath.Join(e.P.Base, "app", "current")); err == nil {
		if v := filepath.Base(t); v != "" && v != "." && v != "/" {
			return v
		}
	}
	if e.kitVersion != "" {
		return e.kitVersion
	}
	return e.readKitVersion()
}

func (e *Enroller) serverAccount() error {
	uid, gid, err := e.LookupUser(e.P.ServerUser)
	if err != nil {
		return fail("kit_incomplete", "server account %s: %v", e.P.ServerUser, err)
	}
	e.srvUID, e.srvGID = uid, gid
	return nil
}

// ---------- start ----------

func (e *Enroller) start() error {
	if e.O.NoStart {
		fmt.Fprintln(e.Out, "mycel-enroll: --no-start: units not started")
		return nil
	}
	if dir := filepath.Dir(e.P.CloudInitDisabled); exists(dir) {
		if err := os.WriteFile(e.P.CloudInitDisabled, nil, 0o644); err != nil {
			return fail("start_failed", "disable cloud-init: %v", err)
		}
	}
	if !e.Systemd {
		fmt.Fprintln(e.Out, "mycel-enroll: systemd is not running here: start the services yourself (mycel-ctl supervise)")
		return nil
	}
	args := append([]string{"enable", "--now"}, e.O.Units...)
	if _, err := e.Run.Run(context.Background(), "systemctl", args, nil); err != nil {
		return fail("start_failed", "systemctl enable --now: %v", err)
	}
	return nil
}

// ---------- standalone (self-host) ----------

func (e *Enroller) standalone() error {
	e.step = "data-disk"
	if err := e.dataDisk(false, true); err != nil {
		return fmt.Errorf("data disk: %w", err)
	}
	if err := e.serverAccount(); err != nil {
		return err
	}
	e.step = "seed"
	if err := e.seed(); err != nil {
		return err
	}
	e.step = "apply"
	tokFile := filepath.Join(e.P.Base, "data", "setup-token")
	token := ""
	if b, err := os.ReadFile(tokFile); err == nil {
		token = strings.TrimSpace(string(b))
	}
	if token == "" {
		t, err := randomToken(24)
		if err != nil {
			return err
		}
		token = t
		if err := e.writeServerFile(tokFile, []byte(token+"\n")); err != nil {
			return fail("apply_failed", "setup token: %v", err)
		}
	}
	port, err := e.mergeServerJSON(func(m map[string]any) {
		m["deployment"] = "self"
		eng := objectAt(m, "engine")
		if _, ok := eng["credentialKinds"]; !ok {
			eng["credentialKinds"] = toAny(allCredentialKinds)
		}
	})
	if err != nil {
		return err
	}
	e.step = "start"
	if err := e.start(); err != nil {
		return err
	}
	fmt.Fprintf(e.Out, `
Team AX is installed (kit %s). First setup:
  1. From your computer:  ssh -L %d:127.0.0.1:%d <this server>
  2. Open:                http://127.0.0.1:%d/setup?token=%s
The token is also in %s (root only). It stops working once the owner account exists.
`, orDash(e.kitVersion), port, port, port, token, tokFile)
	return nil
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }
