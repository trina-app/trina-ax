package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// fakeTenant: the parts of a tenant command that need a real server account, server, launcher or systemd.
type fakeTenant struct {
	adminCalls [][]string
	adminStdin []string
	adminOut   map[string]string // first admin.js argument -> stdout
	adminErr   error
	restarts   int
	hups       int
	turns      []int
}

func (f *fakeTenant) install(t *testing.T) {
	tenantTestHook = func(tn *tenant) {
		tn.admin = func(stdin []byte, _ time.Duration, args ...string) ([]byte, error) {
			f.adminCalls = append(f.adminCalls, args)
			f.adminStdin = append(f.adminStdin, string(stdin))
			if f.adminErr != nil {
				return nil, f.adminErr
			}
			return []byte(f.adminOut[args[0]]), nil
		}
		tn.restart = func() (bool, error) { f.restarts++; return true, nil }
		tn.hup = func() { f.hups++ }
		tn.liveTurns = func() (int, error) {
			if len(f.turns) == 0 {
				return 0, nil
			}
			n := f.turns[0]
			if len(f.turns) > 1 {
				f.turns = f.turns[1:]
			}
			return n, nil
		}
		tn.sleep = func(time.Duration) {}
		// the server-account half runs in this process (the test's uid plays both accounts)
		tn.asServerFn = func(stdin []byte, args ...string) error {
			e := newEnv()
			e.stdin, e.stdout, e.stderr = bytes.NewReader(stdin), &bytes.Buffer{}, &bytes.Buffer{}
			_, err := map[string]func(*env, []string) (int, error){"server-write": cmdServerWrite, "server-config-merge": cmdServerConfigMerge}[args[0]](e, append(args[1:], "--base", tn.e.base))
			return err
		}
	}
	t.Cleanup(func() { tenantTestHook = nil })
}

// tctl runs a tenant command through runEnv (the real flag parsing) with the test base.
func (tb *testBase) tctl(stdin string, args ...string) (int, string, string) {
	e := newEnv()
	var out, errb bytes.Buffer
	e.stdout, e.stderr, e.stdin = &out, &errb, strings.NewReader(stdin)
	e.systemctl = filepath.Join(tb.fakeBin, "systemctl")
	full := append([]string{args[0], "--base", tb.base, "--systemctl", e.systemctl}, args[1:]...)
	code := runEnv(e, full)
	return code, out.String(), errb.String()
}

func jsonOf(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("not one JSON object: %q", s)
	}
	return m
}

const noticesOK = `{"format":1,"issuedAt":"2026-10-22T00:00:00Z","notices":[{"id":"maint","level":"info","audience":"everyone","text":{"ko":"점검","en":"Maintenance","id":"Pemeliharaan"},"link":null,"until":null}]}`

func TestTenantNoticesSet(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{}
	f.install(t)
	code, out, errs := tb.tctl(noticesOK, "notices-set", "--json")
	if code != 0 || strings.TrimSpace(out) != `{"ok":true}` || f.hups != 1 {
		t.Fatalf("%d %q %s hups=%d", code, out, errs, f.hups)
	}
	b, _ := os.ReadFile(filepath.Join(tb.base, "root/notices.json"))
	st, _ := os.Stat(filepath.Join(tb.base, "root/notices.json"))
	if strings.TrimSpace(string(b)) != noticesOK || st.Mode().Perm() != 0o644 {
		t.Fatalf("notices.json %q %v", b, st.Mode())
	}
	for _, bad := range []string{
		strings.Replace(noticesOK, `"format":1`, `"format":2`, 1),
		strings.Replace(noticesOK, `"level":"info"`, `"level":"shout"`, 1),
		strings.Replace(noticesOK, `"audience":"everyone"`, `"audience":"world"`, 1),
		strings.Replace(noticesOK, `"notices":[{`, `"notices":[{"id":"maint","level":"info","audience":"owner"},{`, 1),
		`[]`, `not json`,
	} {
		if code, out, _ := tb.tctl(bad, "notices-set", "--json"); code == 0 || out != "" {
			t.Fatalf("accepted %s: %q", bad, out)
		}
	}
	b2, _ := os.ReadFile(filepath.Join(tb.base, "root/notices.json"))
	if !bytes.Equal(b, b2) {
		t.Fatal("a refused file replaced notices.json")
	}
}

func TestTenantSetServerConfig(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{}
	f.install(t)
	sj := filepath.Join(tb.base, "config/server.json")
	must(t, os.WriteFile(sj, []byte(`{"update":{"channel":"stable","feedUrl":null},"relay":{"url":"wss://relay.treesoop.com/connect","teamName":"acme"},"engine":{"authMode":"managed","proxyPort":47821},"big":12345678901234567890}`), 0o600))
	must(t, os.Chmod(sj, 0o600)) // the server account's file mode is kept
	patch := `{"relay":{"teamName":"acme-two"},"publicOrigins":["https://acme-two.treesoop.com","http://acme.localhost:19100"],"engine":{"credentialKinds":["anthropic-api-key","openai-api-key"]}}`
	code, out, errs := tb.tctl(patch, "set-server-config", "--json")
	if code != 0 || strings.TrimSpace(out) != `{"ok":true,"restarted":true}` || f.restarts != 1 {
		t.Fatalf("%d %q %s", code, out, errs)
	}
	b, _ := os.ReadFile(sj)
	got := string(b)
	for _, want := range []string{`"teamName": "acme-two"`, `"url": "wss://relay.treesoop.com/connect"`, `"https://acme-two.treesoop.com"`, `"proxyPort": 47821`, `"authMode": "managed"`, `12345678901234567890`, `"openai-api-key"`, `"channel": "stable"`} {
		if !strings.Contains(got, want) {
			t.Fatalf("server.json lost or missed %s:\n%s", want, got)
		}
	}
	if st, _ := os.Stat(sj); st.Mode().Perm() != 0o600 {
		t.Fatalf("server.json mode %v", st.Mode())
	}
	for _, bad := range []string{`{}`, `{"listen":{"port":1}}`, `{"publicOrigins":["http://evil.example"]}`, `{"engine":{"credentialKinds":["magic"]}}`,
		`{"relay":{"teamName":"acme","url":"wss://x"}}`, `{"relay":{"teamName":"a"}}`, `{"engine":{"credentialKinds":[],"authMode":"local-login"}}`} {
		if code, out, _ := tb.tctl(bad, "set-server-config", "--json"); code == 0 || out != "" {
			t.Fatalf("accepted %s", bad)
		}
	}
	if f.restarts != 1 {
		t.Fatal("a refused patch restarted the server")
	}
}

func TestTenantRelayRegistrationSet(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{}
	f.install(t)
	reg := `{"relayApi":"https://relay.treesoop.com","teamId":"0f6c2b1e-6a4c-4e0e-9a51-2d1f6f3b7c10","teamName":"acme","publicKey":"MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=","address":"https://acme.treesoop.com"}`
	code, out, errs := tb.tctl(`{"relayRegistration":`+reg+`}`, "relay-registration-set", "--json")
	if code != 0 || strings.TrimSpace(out) != `{"ok":true}` || f.restarts != 1 {
		t.Fatalf("%d %q %s", code, out, errs)
	}
	p := filepath.Join(tb.base, "data/relay/registration.json")
	b, _ := os.ReadFile(p)
	st, _ := os.Stat(p)
	if jsonOf(t, string(b))["teamName"] != "acme" || st.Mode().Perm() != 0o600 {
		t.Fatalf("%s %v", b, st.Mode())
	}
	for _, bad := range []string{`{"relayRegistration":` + strings.Replace(reg, "https://relay", "http://relay", 1) + `}`, `{"relayRegistration":` + strings.Replace(reg, `"teamName":"acme"`, `"teamName":"acme","extra":1`, 1) + `}`, `{"other":1}`} {
		if code, _, _ := tb.tctl(bad, "relay-registration-set", "--json"); code == 0 {
			t.Fatalf("accepted %s", bad)
		}
	}
	// the server-account half writes only its allow-listed file
	e := newEnv()
	e.stdin, e.stdout, e.stderr = strings.NewReader("x"), &bytes.Buffer{}, &bytes.Buffer{}
	if code, _ := cmdServerWrite(e, []string{"--file", "config/server.json", "--base", tb.base}); code != 2 {
		t.Fatal("server-write wrote a file that is not on its list")
	}
}

func TestTenantAdminCommands(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{adminOut: map[string]string{
		"relay-key":              `{"publicKey":"PK","created":false,"sig":"SIG"}`,
		"cloud-backup":           `{"localId":"20261022T020000Z-daily","scope":"full","base":null,"files":[{"name":"db.sqlite.zst","plainSize":1}],"meta":{}}`,
		"archive":                `{"passphrase":"p","size":1,"sha256":"x","parts":[{"n":1,"etag":"e"}]}`,
		"reset-link":             `{"url":"https://acme.treesoop.com/reset-password/abc","expiresAt":"2026-10-23T00:00:00.000Z"}`,
		"setup-token-rotate":     `{"setupToken":"tok_0123456789abcdefghijklmn"}`,
		"credentials-escrow-out": `{"absent":true}`,
	}}
	f.install(t)
	type c struct {
		stdin string
		args  []string
		want  []string // admin.js argv
		out   string   // a key of the answer
	}
	team := "0f6c2b1e-6a4c-4e0e-9a51-2d1f6f3b7c10"
	recip := "age1" + strings.Repeat("q", 58)
	for _, x := range []c{
		{"", []string{"relay-key-proof", "--json", "--team-id", team}, []string{"relay-key", "--sign-rotate", team}, "sig"},
		{"", []string{"backup-prepare", "--json", "--kind", "daily", "--local-id", "20261022T020000Z-daily"}, []string{"cloud-backup", "prepare", "--kind", "daily", "--local-id", "20261022T020000Z-daily"}, "localId"},
		{`{"localId":"x"}`, []string{"backup-upload", "--json"}, []string{"cloud-backup", "upload"}, "localId"},
		{`{"partSize":1,"partUrls":[]}`, []string{"export", "--json"}, []string{"archive", "--passphrase-random", "--upload"}, "passphrase"},
		{"", []string{"reset-link", "--json", "--owner"}, []string{"reset-link"}, "url"},
		{"", []string{"reset-link", "--json", "--username", "kim.lee@acme"}, []string{"reset-link", "--username", "kim.lee@acme"}, "url"},
		{"", []string{"setup-token-rotate", "--json"}, []string{"setup-token-rotate"}, "setupToken"},
		{"", []string{"credentials-escrow-out", "--json", "--recipient", recip}, []string{"credentials-escrow-out", "--recipient", recip}, "absent"},
	} {
		f.adminCalls = nil
		code, out, errs := tb.tctl(x.stdin, x.args...)
		if code != 0 || len(f.adminCalls) != 1 || strings.Join(f.adminCalls[0], " ") != strings.Join(x.want, " ") {
			t.Fatalf("%v: %d %q %s %v", x.args, code, out, errs, f.adminCalls)
		}
		if _, ok := jsonOf(t, out)[x.out]; !ok || strings.Count(out, "\n") != 1 {
			t.Fatalf("%v: answer %q", x.args, out)
		}
		if x.stdin != "" && f.adminStdin[len(f.adminStdin)-1] != x.stdin {
			t.Fatalf("%v: stdin not passed on", x.args)
		}
		if x.args[0] == "relay-key-proof" && strings.Contains(out, "created") {
			t.Fatal("relay-key-proof answers only publicKey and sig")
		}
	}
	if f.restarts != 1 {
		t.Fatalf("setup-token-rotate restarts the server once, got %d restarts", f.restarts)
	}
	// refused before admin.js runs: bad args (exit 2), and an admin.js answer that is not JSON (exit 1, empty stdout)
	f.adminCalls = nil
	for _, bad := range [][]string{
		{"relay-key-proof", "--json", "--team-id", "-rf x"}, {"backup-prepare", "--json", "--kind", "weekly"},
		{"backup-prepare", "--json", "--kind", "daily", "--local-id", "../x"}, {"reset-link", "--json"},
		{"reset-link", "--json", "--owner", "--username", "kim"}, {"reset-link", "--json", "--username", "../root"},
		{"credentials-escrow-out", "--json", "--recipient", "age1nope"}, {"idle-wait", "--json", "--max", "99999"},
		{"status", "--json", "--path", "/etc/shadow"},
	} {
		if code, out, _ := tb.tctl("", bad...); code == 0 || out != "" {
			t.Fatalf("accepted %v", bad)
		}
	}
	if len(f.adminCalls) != 0 {
		t.Fatalf("admin.js ran for refused arguments: %v", f.adminCalls)
	}
	f.adminOut["reset-link"] = "one-time link: https://…"
	if code, out, _ := tb.tctl("", "reset-link", "--json", "--owner"); code == 0 || out != "" {
		t.Fatalf("a non-JSON admin.js answer got through: %d %q", code, out)
	}
}

func TestTenantIdleWaitPrepareStop(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	systemdRunDir = t.TempDir()
	t.Cleanup(func() { systemdRunDir = "/run/systemd/system" })
	f := &fakeTenant{turns: []int{2, 1, 0}, adminOut: map[string]string{}}
	f.install(t)
	if code, out, errs := tb.tctl("", "idle-wait", "--json", "--max", "600"); code != 0 || strings.TrimSpace(out) != `{"idle":true,"running":0}` {
		t.Fatalf("%d %q %s", code, out, errs)
	}
	f.turns = []int{3}
	if code, out, _ := tb.tctl("", "idle-wait", "--json", "--max", "0"); code != 0 || strings.TrimSpace(out) != `{"idle":false,"running":3}` {
		t.Fatalf("%d %q", code, out)
	}
	// --activity (F2 sleep): admin.js cloud-idle facts; sleepable only when idle here too
	f.turns = []int{0}
	f.adminOut["cloud-idle"] = `{"fresh":true,"connections":0,"idleForSec":1900,"nextScheduleInSec":null,"queued":0,"sleepable":true}`
	if code, out, errs := tb.tctl("", "idle-wait", "--json", "--activity", "--max", "0"); code != 0 || strings.TrimSpace(out) != `{"connections":0,"idle":true,"idleForSec":1900,"nextScheduleInSec":null,"running":0,"sleepable":true}` {
		t.Fatalf("%d %q %s", code, out, errs)
	}
	f.turns = []int{1}
	if code, out, _ := tb.tctl("", "idle-wait", "--json", "--activity", "--max", "0"); code != 0 || !strings.Contains(out, `"sleepable":false`) || !strings.Contains(out, `"running":1`) {
		t.Fatalf("a running answer must not be sleepable: %d %q", code, out)
	}
	f.turns = []int{0}
	f.adminOut["cloud-idle"] = `{"fresh":false,"connections":null,"idleForSec":null,"nextScheduleInSec":null,"queued":null,"sleepable":false}`
	if code, out, _ := tb.tctl("", "idle-wait", "--json", "--activity", "--max", "0"); code != 0 || strings.TrimSpace(out) != `{"connections":null,"idle":true,"idleForSec":null,"nextScheduleInSec":null,"running":0,"sleepable":false}` {
		t.Fatalf("stale status must not be sleepable: %d %q", code, out)
	}
	f.adminErr = errors.New("admin.js failed")
	if code, out, _ := tb.tctl("", "idle-wait", "--json", "--activity", "--max", "0"); code != 0 || !strings.Contains(out, `"sleepable":false`) {
		t.Fatalf("an admin.js failure must not be sleepable: %d %q", code, out)
	}
	f.adminErr = nil
	f.turns = []int{0}
	if code, out, errs := tb.tctl("", "prepare-stop", "--json", "--grace", "60"); code != 0 || strings.TrimSpace(out) != `{"stopped":true}` {
		t.Fatalf("%d %q %s", code, out, errs)
	}
	calls, _ := os.ReadFile(tb.sysCalls)
	if !strings.Contains(string(calls), "stop mycel-server.service mycel-launcher.service") {
		t.Fatalf("systemctl %s", calls)
	}
}

// status --json is the strict TenantStatus: exactly its fields (shared/src/cloud-protocol), the app's part from admin.js.
func TestTenantStatus(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{adminOut: map[string]string{"cloud-status": `{"setupNeeded":false,"activeMembers":7,"queue":{"running":1,"queued":0},"relay":{"state":"connected","detail":"the relay at 1.2.3.4"},"lastLocalBackup":{"id":"20261022T020000Z-daily","at":"2026-10-22T02:00:00.000Z"},"lastUploadedLocalId":null,"overall":"warn","checks":[{"id":"relay","status":"ok"},{"id":"Bad Id","status":"ok"}],"ai":{"claude":"ok","codex":"none"},"credentialsKey":{"present":true,"version":1},"ownerEmail":"olga@acme.example"}`}}
	f.install(t)
	code, out, errs := tb.tctl("", "status", "--json")
	if code != 0 {
		t.Fatalf("%d %s", code, errs)
	}
	s := jsonOf(t, out)
	var keys []string
	for k := range s {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := "activeMembers ai app at checks credentialsKey kitVersion lastLocalBackup lastUploadedLocalId overall queue relay resources rootVersion setupNeeded update"
	if strings.Join(keys, " ") != want {
		t.Fatalf("fields %v", keys)
	}
	app := s["app"].(map[string]any)
	if app["health"] != "ok" || app["version"] != "0.3.0" || s["kitVersion"] != "0.3.0" || s["rootVersion"] != "0.3.0" || s["activeMembers"] != float64(7) {
		t.Fatalf("%s", out)
	}
	if s["relay"].(map[string]any)["detail"] != nil || len(s["checks"].([]any)) != 1 || strings.Contains(out, "acme.example") || strings.Contains(out, "1.2.3.4") {
		t.Fatalf("free text or unknown fields got through: %s", out)
	}
	res := s["resources"].(map[string]any)
	if len(res) != 7 || res["diskTotal"].(float64) <= 0 {
		t.Fatalf("resources %v", res)
	}
	// admin.js does not answer (server account broken): still a valid status with the app's part unknown
	f.adminErr = os.ErrPermission
	code, out, _ = tb.tctl("", "status", "--json")
	s = jsonOf(t, out)
	if code != 0 || s["overall"] != "unknown" || s["setupNeeded"] != nil || s["ai"].(map[string]any)["claude"] != "none" {
		t.Fatalf("%d %s", code, out)
	}
	// the install's own report stays available
	f.adminErr = nil
	if code, out, _ := tb.tctl("", "status", "--detail", "--json"); code != 0 || jsonOf(t, out)["units"] == nil {
		t.Fatalf("--detail: %d %s", code, out)
	}
}

// Every argv of the contract's vectors (shared/src/cloud-protocol/vectors/vectors.json) parses here.
func TestTenantArgvVectors(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{adminOut: map[string]string{"relay-key": `{"publicKey":"PK","sig":"S"}`, "reset-link": `{"url":"https://a.b/c","expiresAt":"x"}`, "cloud-backup": `{"localId":"20261022T020000Z-daily"}`, "cloud-status": `{}`}}
	f.install(t)
	b, err := os.ReadFile("../../../shared/src/cloud-protocol/vectors/vectors.json")
	must(t, err)
	var v struct {
		TenantCommandArgv []struct {
			Argv []string `json:"argv"`
		} `json:"tenantCommandArgv"`
	}
	must(t, json.Unmarshal(b, &v))
	if len(v.TenantCommandArgv) < 5 {
		t.Fatal("no vectors")
	}
	for _, x := range v.TenantCommandArgv {
		if code, out, errs := tb.tctl("", x.Argv...); code != 0 || out == "" {
			t.Fatalf("%v: %d %q %s", x.Argv, code, out, errs)
		}
	}
}
