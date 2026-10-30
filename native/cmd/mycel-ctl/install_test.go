package main

import (
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func testInstall(t *testing.T, base string) *Install {
	t.Helper()
	me, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	// both accounts are the test's own account (lookups must work; the names differ only for validation)
	in := &Install{Format: 1, ID: "mycel", Base: base, ServerUser: me.Username, AgentUser: me.Username, Port: 47820, ProxyPort: 47821,
		Engines: []string{"claude", "codex"}, Version: "0.3.0", Systemd: true}
	return in
}

func TestParseInstall(t *testing.T) {
	good := `{"format":1,"id":"mycel","base":"/var/lib/mycel","serverUser":"axserver","agentUser":"axagent","port":47820,"proxyPort":47821,"tlsPort":0,"hosted":false,"autoUpdate":true,"allowUnsigned":false,"engines":["claude","codex"],"version":"0.3.0","systemd":true}`
	if _, err := parseInstall([]byte(good)); err != nil {
		t.Fatal(err)
	}
	for _, b := range []string{
		strings.Replace(good, `"agentUser":"axagent"`, `"agentUser":"axserver"`, 1),
		strings.Replace(good, `"base":"/var/lib/mycel"`, `"base":"/var/lib/my cel"`, 1),
		strings.Replace(good, `"base":"/var/lib/mycel"`, `"base":"var/lib/mycel"`, 1),
		strings.Replace(good, `"engines":["claude","codex"]`, `"engines":["sh"]`, 1),
		strings.Replace(good, `"version":"0.3.0"`, `"version":"../x"`, 1),
		strings.Replace(good, `"id":"mycel"`, `"id":"Mycel"`, 1),
		strings.Replace(good, `"proxyPort":47821`, `"proxyPort":47820`, 1),
	} {
		if _, err := parseInstall([]byte(b)); err == nil {
			t.Errorf("accepted %s", b)
		}
	}
}

// launcherArgv / bootstrapArgv are spec 3.2.2 / 3.2.3, and the rendered unit templates say the same
func TestArgvMatchesSpecAndTemplates(t *testing.T) {
	in := testInstall(t, "/var/lib/mycel")
	in.Hosted = true
	got := launcherArgv(in, 989, "/etc/ssl/certs/ca-certificates.crt", "required")
	want := strings.Fields(`/var/lib/mycel/root/mycel-launcher --listen /var/lib/mycel/run-launcher/launcher.sock --mode 0660 --agent-root /var/lib/mycel/agent
		--bridge /var/lib/mycel/app/current/native/mycel-bridge --tools-sock /var/lib/mycel/run/tools/tools.sock --server-uid 989 --dedicated-account
		--sandbox bwrap --bwrap /usr/bin/bwrap --sandbox-helper /var/lib/mycel/root/mycel-sandbox --sandbox-etc /var/lib/mycel/root/sandbox-etc
		--ca-bundle /etc/ssl/certs/ca-certificates.crt --landlock required-scoped --proxy-port 47821 --codex-auth-dir /var/lib/mycel/agent/codex-auth
		--firewall-status /var/lib/mycel/run/firewall.json --plan-file /var/lib/mycel/root/plan.json --cgroup required
		--allow-cmd /var/lib/mycel/app/engines/claude/current/claude --allow-cmd /var/lib/mycel/app/engines/codex/current/codex`)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("launcher argv\n%v\nwant\n%v", got, want)
	}
	b := bootstrapArgv(in)
	if b[0] != "/var/lib/mycel/root/mycel-bootstrap" || b[2] != "/var/lib/mycel/app" || b[4] != "/var/lib/mycel/config/server.json" || b[5] != "--pubkey" || strings.Contains(strings.Join(b, " "), "--allow-unsigned") {
		t.Fatalf("bootstrap argv %v", b)
	}
	in.AllowUnsigned = true
	if !strings.HasSuffix(strings.Join(bootstrapArgv(in), " "), "--allow-unsigned") || !strings.Contains(strings.Join(serverEnv(in), " "), "MYCEL_ALLOW_UNSIGNED=1") {
		t.Fatal("--allow-unsigned install")
	}
	// the template, rendered from the same Install, has the same ExecStart
	vals, err := unitValues(in)
	if err != nil {
		t.Fatal(err)
	}
	vals["SRV_UID"], vals["CA_BUNDLE"] = "989", "/etc/ssl/certs/ca-certificates.crt"
	for name, argv := range map[string][]string{"launcher.service.in": launcherArgv(in, 989, "/etc/ssl/certs/ca-certificates.crt", in.cgroupMode()), "server.service.in": bootstrapArgv(in)} {
		tmpl, _ := os.ReadFile(filepath.Join("testdata", name))
		text, err := renderTemplate(string(tmpl), vals)
		if err != nil {
			t.Fatal(err)
		}
		if exec := execStart(text); !reflect.DeepEqual(exec, argv) {
			t.Fatalf("%s ExecStart\n%v\nargv\n%v", name, exec, argv)
		}
	}
	if _, err := renderTemplate("x @NOPE@ y", vals); err == nil {
		t.Fatal("unknown placeholder accepted")
	}
}

// execStart joins the ExecStart= line with its `\` continuations and splits it into words.
func execStart(unit string) []string {
	var b strings.Builder
	on := false
	for _, l := range strings.Split(unit, "\n") {
		if strings.HasPrefix(l, "ExecStart=") {
			on, l = true, strings.TrimPrefix(l, "ExecStart=")
		}
		if !on {
			continue
		}
		cont := strings.HasSuffix(strings.TrimSpace(l), "\\")
		b.WriteString(strings.TrimSuffix(strings.TrimSpace(l), "\\") + " ")
		if !cont {
			break
		}
	}
	return strings.Fields(b.String())
}

func TestUnitName(t *testing.T) {
	for in, want := range map[string]string{"launcher.service.in": "mycel-launcher.service", "firewall.timer.in": "mycel-firewall.timer", "slice.in": "mycel.slice"} {
		if got, ok := unitName("mycel", in); !ok || got != want {
			t.Errorf("%s -> %s", in, got)
		}
	}
	for _, in := range []string{"apparmor-bwrap.in", "launcher.service", "x.conf.in"} {
		if _, ok := unitName("mycel", in); ok {
			t.Errorf("%s accepted", in)
		}
	}
}

func TestUnitEnv(t *testing.T) {
	in := testInstall(t, "/var/lib/mycel")
	env := serverEnv(in)
	for _, want := range []string{"MYCEL_INSTALL_BASE=/var/lib/mycel", "MYCEL_LABEL=mycel", "MYCEL_PLAN_FILE=/var/lib/mycel/root/plan.json", "MYCEL_SANDBOX_HELPER=/var/lib/mycel/root/mycel-sandbox", "MYCEL_SAFE_OPS_BIN=/var/lib/mycel/root/safe-ops", "HOME=/var/lib/mycel/data"} {
		if !strings.Contains(strings.Join(env, "\n"), want) {
			t.Errorf("server env lacks %s", want)
		}
	}
	if strings.Join(launcherEnv(in), " ") != "PATH=/usr/bin:/bin HOME=/var/lib/mycel/agent/home" {
		t.Errorf("launcher env %v", launcherEnv(in))
	}
}
