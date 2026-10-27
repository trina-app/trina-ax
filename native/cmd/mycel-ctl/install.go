package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"mycel/native/internal/bundle"
)

// Install is <base>/root/install.json: the installer's arguments, written by scripts/install-linux.sh (root 0644)
// and read here so update, supervise, status and render-units act on the same values as the installer.
type Install struct {
	Format        int      `json:"format"`
	ID            string   `json:"id"`
	Base          string   `json:"base"`
	ServerUser    string   `json:"serverUser"`
	AgentUser     string   `json:"agentUser"`
	Port          int      `json:"port"`
	ProxyPort     int      `json:"proxyPort"`
	TLSPort       int      `json:"tlsPort"`
	Hosted        bool     `json:"hosted"`
	AutoUpdate    bool     `json:"autoUpdate"`
	AllowUnsigned bool     `json:"allowUnsigned"`
	Engines       []string `json:"engines"`
	Version       string   `json:"version"`
	Systemd       bool     `json:"systemd"`
}

var (
	idRe     = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}$`)
	userRe   = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	engineRe = regexp.MustCompile(`^(claude|codex)$`)
)

func parseInstall(b []byte) (*Install, error) {
	var in Install
	if err := json.Unmarshal(b, &in); err != nil {
		return nil, fmt.Errorf("install.json: %v", err)
	}
	if in.Format != 1 {
		return nil, fmt.Errorf("install.json: format must be 1")
	}
	if !idRe.MatchString(in.ID) {
		return nil, fmt.Errorf("install.json: bad id %q", in.ID)
	}
	if !filepath.IsAbs(in.Base) || filepath.Clean(in.Base) != in.Base || strings.ContainsAny(in.Base, " \t\n\"'\\$`") {
		return nil, fmt.Errorf("install.json: bad base %q", in.Base)
	}
	if !userRe.MatchString(in.ServerUser) || !userRe.MatchString(in.AgentUser) || in.ServerUser == in.AgentUser {
		return nil, fmt.Errorf("install.json: bad account names")
	}
	for _, p := range []int{in.Port, in.ProxyPort} {
		if p < 1 || p > 65535 {
			return nil, fmt.Errorf("install.json: bad port %d", p)
		}
	}
	if in.TLSPort < 0 || in.TLSPort > 65535 || in.Port == in.ProxyPort {
		return nil, fmt.Errorf("install.json: bad ports")
	}
	for _, e := range in.Engines {
		if !engineRe.MatchString(e) {
			return nil, fmt.Errorf("install.json: unknown engine %q", e)
		}
	}
	if in.Version != "" && !bundle.ValidVersion(in.Version) {
		return nil, fmt.Errorf("install.json: bad version %q", in.Version)
	}
	return &in, nil
}

func loadInstall(e *env) (*Install, error) {
	b, err := readRootFile(e.root("install.json"), 64<<10)
	if err != nil {
		return nil, err
	}
	in, err := parseInstall(b)
	if err != nil {
		return nil, err
	}
	if in.Base != e.base {
		return nil, fmt.Errorf("install.json is for %s, not %s", in.Base, e.base)
	}
	return in, nil
}

// accounts resolves the two role accounts (uid, gid).
type account struct{ uid, gid int }

func lookupAccount(name string) (account, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return account{}, err
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	return account{uid, gid}, nil
}

// caBundle is the first CA file of the system (engine sandbox /etc/ssl/cert.pem, spec D26).
var caCandidates = []string{"/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"}

func caBundle() string {
	for _, c := range caCandidates {
		if st, err := os.Stat(c); err == nil && st.Mode().IsRegular() {
			return c
		}
	}
	return caCandidates[0]
}

func (in *Install) landlockMode() string {
	if in.Hosted {
		return "required-scoped"
	}
	return "required"
}

func (in *Install) cgroupMode() string {
	if in.Hosted {
		return "required"
	}
	return "auto"
}

func (in *Install) pubkeyArgs() []string {
	var a []string
	for _, k := range bundle.ReleaseKeys {
		a = append(a, "--pubkey", k)
	}
	if in.AllowUnsigned {
		a = append(a, "--allow-unsigned")
	}
	return a
}

func (in *Install) engineArgs() []string {
	var a []string
	for _, n := range in.Engines {
		a = append(a, "--allow-cmd", filepath.Join(in.Base, "app", "engines", n, "current", n))
	}
	return a
}

// launcherArgv is the launcher's command line (spec 3.2.2 ExecStart). The unit template and supervise must agree:
// render-units fills the template's placeholders from the same Install, and the test compares both.
func launcherArgv(in *Install, serverUID int, ca, cgroup string) []string {
	b := in.Base
	a := []string{filepath.Join(b, "root", "mycel-launcher"),
		"--listen", filepath.Join(b, "run-launcher", "launcher.sock"), "--mode", "0660", "--agent-root", filepath.Join(b, "agent"),
		"--bridge", filepath.Join(b, "app", "current", "native", "mycel-bridge"), "--tools-sock", filepath.Join(b, "run", "tools", "tools.sock"),
		"--server-uid", strconv.Itoa(serverUID), "--dedicated-account",
		"--sandbox", "bwrap", "--bwrap", "/usr/bin/bwrap", "--sandbox-helper", filepath.Join(b, "root", "mycel-sandbox"),
		"--sandbox-etc", filepath.Join(b, "root", "sandbox-etc"), "--ca-bundle", ca, "--landlock", in.landlockMode(),
		"--proxy-port", strconv.Itoa(in.ProxyPort), "--codex-auth-dir", filepath.Join(b, "agent", "codex-auth"),
		"--firewall-status", filepath.Join(b, "run", "firewall.json"), "--plan-file", filepath.Join(b, "root", "plan.json"), "--cgroup", cgroup,
	}
	return append(a, in.engineArgs()...)
}

// launcherEnv is the launcher unit's Environment= (spec 3.2.2).
func launcherEnv(in *Install) []string {
	return []string{"PATH=/usr/bin:/bin", "HOME=" + filepath.Join(in.Base, "agent", "home")}
}

// bootstrapArgv is the server unit's ExecStart (spec 3.2.3).
func bootstrapArgv(in *Install) []string {
	a := []string{filepath.Join(in.Base, "root", "mycel-bootstrap"), "--app", filepath.Join(in.Base, "app"), "--config", filepath.Join(in.Base, "config", "server.json")}
	return append(a, in.pubkeyArgs()...)
}

// serverEnv is the server unit's Environment= (spec 3.2.3, plus MYCEL_SANDBOX_HELPER for the converter cgroup, 3.8.2,
// and MYCEL_ALLOW_UNSIGNED for development installs, 3.6.3). /etc/default/<id> is added by the caller.
func serverEnv(in *Install) []string {
	b := in.Base
	v := []string{"PATH=/usr/bin:/bin", "HOME=" + filepath.Join(b, "data"), "MYCEL_INSTALL_BASE=" + b, "MYCEL_LABEL=" + in.ID,
		"MYCEL_WEB_DIST=" + filepath.Join(b, "app", "current", "web"), "MYCEL_PLAN_FILE=" + filepath.Join(b, "root", "plan.json"),
		"MYCEL_SANDBOX_HELPER=" + filepath.Join(b, "root", "mycel-sandbox")}
	if in.AllowUnsigned {
		v = append(v, "MYCEL_ALLOW_UNSIGNED=1")
	}
	return v
}

// placeholders of the unit templates (scripts/linux/systemd/*.in, installed as <base>/root/systemd/*.in)
func unitValues(in *Install) (map[string]string, error) {
	srv, err := lookupAccount(in.ServerUser)
	if err != nil {
		return nil, fmt.Errorf("server account %s: %v", in.ServerUser, err)
	}
	agt, err := lookupAccount(in.AgentUser)
	if err != nil {
		return nil, fmt.Errorf("engine account %s: %v", in.AgentUser, err)
	}
	return map[string]string{
		"BASE": in.Base, "ID": in.ID, "SRV": in.ServerUser, "AGT": in.AgentUser,
		"SRV_UID": strconv.Itoa(srv.uid), "AGT_UID": strconv.Itoa(agt.uid),
		"PORT": strconv.Itoa(in.Port), "PROXY_PORT": strconv.Itoa(in.ProxyPort), "TLS_PORT": strconv.Itoa(in.TLSPort),
		"PUBKEYS": strings.Join(in.pubkeyArgs(), " "), "ENGINE_ARGS": strings.Join(in.engineArgs(), " "),
		"CA_BUNDLE": caBundle(), "LANDLOCK": in.landlockMode(), "CGROUP": in.cgroupMode(),
		"ALLOW_UNSIGNED_ENV": map[bool]string{true: "MYCEL_ALLOW_UNSIGNED=1", false: ""}[in.AllowUnsigned],
	}, nil
}

var placeholderRe = regexp.MustCompile(`@([A-Z_]+)@`)

// renderTemplate fills @NAME@ placeholders; an unknown one refuses (fail closed: a unit with a literal @X@ would run
// with a wrong argument).
func renderTemplate(text string, vals map[string]string) (string, error) {
	var missing []string
	out := placeholderRe.ReplaceAllStringFunc(text, func(m string) string {
		k := m[1 : len(m)-1]
		v, ok := vals[k]
		if !ok {
			missing = append(missing, k)
			return m
		}
		return v
	})
	if len(missing) > 0 {
		return "", fmt.Errorf("unknown placeholder @%s@", strings.Join(missing, "@, @"))
	}
	return out, nil
}

// unitName maps a template file name (launcher.service.in) to the installed unit (<id>-launcher.service).
func unitName(id, tmpl string) (string, bool) {
	n := strings.TrimSuffix(tmpl, ".in")
	if n == tmpl || !(strings.HasSuffix(n, ".service") || strings.HasSuffix(n, ".timer")) {
		return "", false
	}
	return id + "-" + n, true
}

// renderUnits writes every <templates>/*.{service,timer}.in to <out>/<id>-*. Returns the unit names written and
// whether any content changed.
func renderUnits(in *Install, templates, out string) ([]string, bool, error) {
	vals, err := unitValues(in)
	if err != nil {
		return nil, false, err
	}
	ents, err := os.ReadDir(templates)
	if err != nil {
		return nil, false, err
	}
	var names []string
	changed := false
	for _, ent := range ents {
		name, ok := unitName(in.ID, ent.Name())
		if !ok || !ent.Type().IsRegular() {
			continue
		}
		b, err := readRootFile(filepath.Join(templates, ent.Name()), 256<<10)
		if err != nil {
			return nil, false, err
		}
		text, err := renderTemplate(string(b), vals)
		if err != nil {
			return nil, false, fmt.Errorf("%s: %v", ent.Name(), err)
		}
		dest := filepath.Join(out, name)
		if old, err := os.ReadFile(dest); err != nil || string(old) != text {
			if err := writeRootFile(dest, []byte(text), 0o644); err != nil {
				return nil, false, err
			}
			changed = true
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names, changed, nil
}

func cmdRenderUnits(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("render-units", flag.ContinueOnError)
	e.flags(fs)
	templates := fs.String("templates", "", "template folder (default <base>/root/systemd)")
	out := fs.String("out", "/etc/systemd/system", "unit folder")
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
	if *templates == "" {
		*templates = e.root("systemd")
	}
	if err := rootOwnedDir(*templates); err != nil {
		return 1, err
	}
	names, changed, err := renderUnits(in, *templates, *out)
	if err != nil {
		return 1, err
	}
	printJSON(e.stdout, map[string]any{"units": names, "changed": changed})
	return 0, nil
}
