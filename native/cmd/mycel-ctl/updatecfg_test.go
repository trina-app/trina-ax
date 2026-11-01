package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mycel/native/internal/bundle"
)

// switchBase: a systemd install (fake systemctl) with the real unit templates, a signed (or unsigned) running version.
func switchBase(t *testing.T, signed bool) (*testBase, *[]string) {
	tb := newTestBase(t, "0.2.18")
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	old := verifyKeys
	verifyKeys = append(append([]string{}, old...), base64.StdEncoding.EncodeToString(pub))
	systemdRunDir, systemdUnitDir, defaultsDir = t.TempDir(), t.TempDir(), t.TempDir()
	server := new([]string)
	settingsAsServer = func(_ *env, _ *Install, args ...string) error {
		*server = append(*server, strings.Join(args, " "))
		return nil
	}
	settingsLiveTurns = func(*env, *Install) (int, error) { return 0, nil }
	settingsSleep = func(time.Duration) {}
	statusScheduleHook = func(u *updater) {
		u.runAsSrv = func(args []string, _ []string) (string, error) {
			return `{"window":"02:00-04:00","timeZone":"Asia/Seoul","custom":true}`, nil
		}
	}
	t.Cleanup(func() {
		statusScheduleHook = nil
		verifyKeys = old
		systemdRunDir, systemdUnitDir, defaultsDir = "/run/systemd/system", "/etc/systemd/system", "/etc/default"
		settingsAsServer = func(e *env, in *Install, args ...string) error { return (&tenant{e: e, in: in}).asServer(nil, args...) }
		settingsLiveTurns = func(e *env, in *Install) (int, error) { return (&updater{e: e, in: in}).launcherLiveTurns() }
		settingsSleep = time.Sleep
	})
	v := filepath.Join(tb.base, "app/versions/0.2.18")
	if signed {
		must(t, bundle.WriteManifest(v, "0.2.18", priv))
	} else {
		must(t, bundle.WriteManifest(v, "0.2.18", nil))
	}
	// install.json as the installer writes it: one key per line (its repair reads it so)
	me := mustUser(t)
	inst := `{
  "format": 1,
  "id": "mycel",
  "base": "` + tb.base + `",
  "serverUser": "` + me + `",
  "agentUser": "nobody",
  "port": ` + itoa(tb.port) + `,
  "proxyPort": 47821,
  "tlsPort": 0,
  "hosted": false,
  "autoUpdate": false,
  "allowUnsigned": true,
  "engines": ["claude"],
  "version": "0.2.18",
  "systemd": true,
  "publicHost": null,
  "appConnectors": null
}
`
	must(t, os.WriteFile(filepath.Join(tb.base, "root/install.json"), []byte(inst), 0o644))
	must(t, os.MkdirAll(filepath.Join(tb.base, "root/systemd"), 0o755))
	for _, n := range []string{"firewall.service.in", "firewall.timer.in", "launcher.service.in", "server.service.in", "slice.in", "update.service.in", "update.timer.in"} {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "scripts", "linux", "systemd", n))
		must(t, err)
		must(t, os.WriteFile(filepath.Join(tb.base, "root/systemd", n), b, 0o644))
	}
	// systemctl is-enabled answers what the last enable / disable said
	enabled := filepath.Join(tb.fakeBin, "timer-enabled")
	must(t, os.WriteFile(filepath.Join(tb.fakeBin, "systemctl"), []byte(`#!/bin/sh
echo "$*" >> '`+tb.sysCalls+`'
case "$1" in
  is-enabled) if [ -f '`+enabled+`' ]; then echo enabled; else echo disabled; exit 1; fi ;;
  enable) touch '`+enabled+`' ;;
  disable) rm -f '`+enabled+`' ;;
esac
`), 0o755))
	return tb, server
}

// unitLines is an installed unit without its comments.
func unitLines(t *testing.T, name string) string {
	b, err := os.ReadFile(filepath.Join(systemdUnitDir, name))
	must(t, err)
	var out []string
	for _, l := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(l, "#") {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

func mustUser(t *testing.T) string {
	in := testInstall(t, "/x")
	return in.ServerUser
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func (tb *testBase) settings(t *testing.T, args ...string) (int, UpdateSettings, string) {
	t.Helper()
	code, out, errs := tb.ctl("", append(args, "--json")...)
	var s UpdateSettings
	if code == 0 {
		if err := json.Unmarshal([]byte(out), &s); err != nil {
			t.Fatalf("%v: %q %s", args, out, errs)
		}
	}
	return code, s, errs
}

func TestAutoUpdateSwitch(t *testing.T) {
	tb, server := switchBase(t, true)
	before, _ := os.ReadFile(filepath.Join(tb.base, "root/install.json"))
	code, s, errs := tb.settings(t, "auto-update", "status")
	if code != 0 || s.AutoUpdate || s.Timer != "disabled" || len(s.Warnings) < 2 || !strings.Contains(s.Warnings[0], "automatic updates are off") ||
		!strings.Contains(s.Warnings[0], "`sudo mycel-ctl auto-update on`") || !strings.Contains(s.Warnings[1], "accepts unsigned versions") {
		t.Fatalf("status: %d %+v %s", code, s, errs)
	}
	os.Remove(tb.sysCalls)
	code, s, errs = tb.settings(t, "auto-update", "on")
	if code != 0 || !s.AutoUpdate || s.Timer != "enabled" || s.UnitsMatch == nil || !*s.UnitsMatch || s.Window != "02:00-04:00" || s.TimeZone != "Asia/Seoul" {
		t.Fatalf("on: %d %+v %s", code, s, errs)
	}
	after, _ := os.ReadFile(filepath.Join(tb.base, "root/install.json"))
	if string(after) != strings.Replace(string(before), `"autoUpdate": false`, `"autoUpdate": true`, 1) {
		t.Fatalf("install.json changed beyond autoUpdate:\n%s", after)
	}
	if strings.Join(*server, "|") != "server-update-auto --auto=true" {
		t.Fatalf("server.json: %q", *server)
	}
	calls, _ := os.ReadFile(tb.sysCalls)
	if !strings.Contains(string(calls), "enable --now mycel-update.timer\n") || !strings.Contains(string(calls), "restart mycel-server.service\n") {
		t.Fatalf("systemctl calls:\n%s", calls)
	}
	// answers running: auto-update never interrupts them for this; the server takes it at its next start
	settingsLiveTurns = func(*env, *Install) (int, error) { return 1, nil }
	os.Remove(tb.sysCalls)
	code, s, _ = tb.settings(t, "auto-update", "off", "--max-wait", "1")
	if code != 0 || s.AutoUpdate || s.Timer != "disabled" || !strings.Contains(strings.Join(s.Notes, " "), "not restarted: 1 answer(s) still running") {
		t.Fatalf("off: %d %+v", code, s)
	}
	if calls, _ := os.ReadFile(tb.sysCalls); strings.Contains(string(calls), "restart") || !strings.Contains(string(calls), "disable --now mycel-update.timer") {
		t.Fatalf("systemctl calls:\n%s", calls)
	}
	// status says when: the team's window and its zone (update audit O2)
	settingsLiveTurns = func(*env, *Install) (int, error) { return 0, nil }
	tb.settings(t, "auto-update", "on")
	if code, out, _ := tb.ctl("", "status"); code != 0 || !strings.Contains(out, "automatic updates: on (root updates inside the team's update window 02:00-04:00 Asia/Seoul when no answer runs") {
		t.Fatalf("status:\n%s", out)
	}
	// a hosted tenant is updated by the control plane
	b, _ := os.ReadFile(filepath.Join(tb.base, "root/install.json"))
	must(t, os.WriteFile(filepath.Join(tb.base, "root/install.json"), []byte(strings.Replace(string(b), `"hosted": false`, `"hosted": true`, 1)), 0o644))
	if code, _, errs := tb.ctl("", "auto-update", "on"); code != 1 || !strings.Contains(errs, "control plane") {
		t.Fatalf("hosted: %d %s", code, errs)
	}
}

func TestAllowUnsignedSwitch(t *testing.T) {
	// the version that runs is unsigned: turning unsigned off would leave the bootstrap nothing to start
	tb, _ := switchBase(t, false)
	if code, _, errs := tb.ctl("", "allow-unsigned", "off"); code != 1 || !strings.Contains(errs, "not a verified release") {
		t.Fatalf("unsigned current: %d %s", code, errs)
	}
	in, _ := loadInstall(&env{base: tb.base})
	if !in.AllowUnsigned {
		t.Fatal("install.json changed although refused")
	}
	// signed: install.json, then the units say the same (no --allow-unsigned, no MYCEL_ALLOW_UNSIGNED), restart
	tb, _ = switchBase(t, true)
	must(t, os.WriteFile(filepath.Join(systemdUnitDir, "mycel-server.service"), []byte("an older unit\n"), 0o644))
	code, s, errs := tb.settings(t, "allow-unsigned", "off")
	if code != 0 || s.AllowUnsigned || s.UnitsMatch == nil || !*s.UnitsMatch {
		t.Fatalf("off: %d %+v %s", code, s, errs)
	}
	unit := unitLines(t, "mycel-server.service")
	if strings.Contains(string(unit), "--allow-unsigned") || strings.Contains(string(unit), "MYCEL_ALLOW_UNSIGNED") || !strings.Contains(string(unit), "root/mycel-bootstrap --app") {
		t.Fatalf("server unit still accepts unsigned:\n%s", unit)
	}
	calls, _ := os.ReadFile(tb.sysCalls)
	if !strings.Contains(string(calls), "daemon-reload\n") || !strings.Contains(string(calls), "restart mycel-server.service\n") {
		t.Fatalf("systemctl calls:\n%s", calls)
	}
	for _, w := range s.Warnings {
		if strings.Contains(w, "unsigned") {
			t.Fatalf("warning left: %q", w)
		}
	}
	// on again (development): the units take --allow-unsigned, and status warns
	code, s, _ = tb.settings(t, "allow-unsigned", "on")
	unit = unitLines(t, "mycel-server.service")
	if code != 0 || !s.AllowUnsigned || !strings.Contains(string(unit), "--allow-unsigned") || !strings.Contains(string(unit), "MYCEL_ALLOW_UNSIGNED=1") {
		t.Fatalf("on: %d %+v\n%s", code, s, unit)
	}
	// a unit edited by hand: status says the units and install.json disagree
	must(t, os.WriteFile(filepath.Join(systemdUnitDir, "mycel-server.service"), []byte("an older unit\n"), 0o644))
	code, out, _ := tb.ctl("", "status")
	if code != 0 || !strings.Contains(out, "WARNING: the systemd units differ from root/install.json") || !strings.Contains(out, "unsigned versions: ALLOWED") ||
		!strings.Contains(out, "automatic updates: OFF") {
		t.Fatalf("status:\n%s", out)
	}
	code, out, _ = tb.ctl("", "status", "--detail", "--json")
	var st Status
	if code != 0 || json.Unmarshal([]byte(out), &st) != nil || st.Updates == nil || !st.Updates.AllowUnsigned || st.Updates.AutoUpdate || st.Updates.Timer != "disabled" {
		t.Fatalf("status --detail --json: %d %s", code, out)
	}
}

// a root update waiting for a quiet moment is shown
func TestStatusShowsDeferredUpdate(t *testing.T) {
	tb, _ := switchBase(t, true)
	must(t, os.WriteFile(filepath.Join(tb.base, "root/update-deferred.json"), []byte(`{"version":"0.2.19","since":"2026-11-02T20:00:00Z","turns":2}`+"\n"), 0o644))
	code, out, _ := tb.ctl("", "status")
	if code != 0 || !strings.Contains(out, "root update to 0.2.19 waits for a quiet moment since 2026-11-02T20:00:00Z (2 answer(s) were running)") {
		t.Fatalf("%d\n%s", code, out)
	}
}

// install.json keeps every other key and line when one switch changes; a file without the key gets it
func TestSetInstallBool(t *testing.T) {
	tb := newTestBase(t, "0.2.18")
	e := &env{base: tb.base}
	b, _ := os.ReadFile(filepath.Join(tb.base, "root/install.json"))
	var m map[string]any
	must(t, json.Unmarshal(b, &m))
	delete(m, "allowUnsigned")
	m["publicHost"] = "team.example.com"
	nb, _ := json.Marshal(m)
	must(t, os.WriteFile(filepath.Join(tb.base, "root/install.json"), nb, 0o644))
	in, err := setInstallBool(e, "allowUnsigned", true)
	if err != nil || !in.AllowUnsigned {
		t.Fatalf("%v %+v", err, in)
	}
	b, _ = os.ReadFile(filepath.Join(tb.base, "root/install.json"))
	if !strings.Contains(string(b), `"publicHost": "team.example.com"`) || !strings.Contains(string(b), "\n  \"allowUnsigned\": true,\n") {
		t.Fatalf("%s", b)
	}
	if in, err := setInstallBool(e, "allowUnsigned", false); err != nil || in.AllowUnsigned {
		t.Fatalf("back: %v", err)
	}
}
