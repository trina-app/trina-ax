package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
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
	// the server's start (error-reports-set compares it with the defaults file); known only when a test sets startKnown
	started    time.Time
	startKnown bool
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
		tn.restart = func() (bool, error) { f.restarts++; f.started = time.Now(); return true, nil }
		tn.serverStarted = func() (time.Time, bool) { return f.started, f.startKnown }
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
		tn.asServerFn = func(stdin []byte, args ...string) ([]byte, error) {
			e := newEnv()
			out := &bytes.Buffer{}
			e.stdin, e.stdout, e.stderr = bytes.NewReader(stdin), out, &bytes.Buffer{}
			_, err := map[string]func(*env, []string) (int, error){"server-write": cmdServerWrite, "server-config-merge": cmdServerConfigMerge}[args[0]](e, append(args[1:], "--base", tn.e.base))
			return out.Bytes(), err
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

// These commands refuse to run as root (they run as the server account), so the tests cannot run as root.
func skipAsRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("needs an account that is not root")
	}
}

func TestTenantSetServerConfig(t *testing.T) {
	skipAsRoot(t)
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
	skipAsRoot(t)
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

// github-app-set: the server account writes secrets/integrations/github/app.json (0600, folder 0700) from a checked
// stdin; the same values again write nothing; a refused shape writes and prints nothing; the secret is never printed.
func TestTenantGitHubAppSet(t *testing.T) {
	skipAsRoot(t)
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{}
	f.install(t)
	const secret = "0123456789abcdef0123456789abcdef01234567"
	app := `{"clientId":"Iv23liTestOnly","clientSecret":"` + secret + `","slug":"example-app"}`
	p := filepath.Join(tb.base, "secrets/integrations/github/app.json")
	// an existing folder with a wider mode is narrowed
	must(t, os.MkdirAll(filepath.Dir(p), 0o755))
	must(t, os.Chmod(filepath.Dir(p), 0o755))
	code, out, errs := tb.tctl(app, "github-app-set", "--json")
	if code != 0 || strings.TrimSpace(out) != `{"ok":true,"changed":true}` || f.restarts != 0 || strings.Contains(out+errs, secret) {
		t.Fatalf("%d %q %s restarts=%d", code, out, errs, f.restarts)
	}
	b, _ := os.ReadFile(p)
	st, _ := os.Lstat(p)
	dst, _ := os.Lstat(filepath.Dir(p))
	if string(b) != app+"\n" || st.Mode().Perm() != 0o600 || !st.Mode().IsRegular() || dst.Mode().Perm() != 0o700 {
		t.Fatalf("app.json %q %v, folder %v", b, st.Mode(), dst.Mode())
	}
	// the same values: nothing written
	before := st.ModTime()
	time.Sleep(10 * time.Millisecond)
	if code, out, _ := tb.tctl(app, "github-app-set", "--json"); code != 0 || strings.TrimSpace(out) != `{"ok":true,"changed":false}` {
		t.Fatalf("resend %d %q", code, out)
	}
	if st2, _ := os.Lstat(p); !st2.ModTime().Equal(before) {
		t.Fatal("the same values wrote the file again")
	}
	// a wider mode or a second link is replaced by a fresh 0600 file
	must(t, os.Chmod(p, 0o644))
	if code, out, _ := tb.tctl(app, "github-app-set", "--json"); code != 0 || strings.TrimSpace(out) != `{"ok":true,"changed":true}` {
		t.Fatalf("mode %d %q", code, out)
	}
	if st2, _ := os.Lstat(p); st2.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st2.Mode())
	}
	other := filepath.Join(tb.base, "elsewhere.json")
	must(t, os.WriteFile(other, []byte("keep"), 0o600))
	must(t, os.Remove(p))
	must(t, os.Symlink(other, p))
	if code, _, _ := tb.tctl(app, "github-app-set", "--json"); code != 0 {
		t.Fatal("a link at the file's name")
	}
	if b, _ := os.ReadFile(other); string(b) != "keep" {
		t.Fatal("wrote through a link")
	}
	if st2, _ := os.Lstat(p); !st2.Mode().IsRegular() {
		t.Fatal("the link is still there")
	}
	// without a slug
	if code, out, _ := tb.tctl(`{"clientId":"Iv1.abc","clientSecret":"s3cr3t!"}`, "github-app-set", "--json"); code != 0 || strings.TrimSpace(out) != `{"ok":true,"changed":true}` {
		t.Fatalf("no slug %d %q", code, out)
	}
	if b, _ := os.ReadFile(p); string(b) != `{"clientId":"Iv1.abc","clientSecret":"s3cr3t!"}`+"\n" {
		t.Fatalf("no slug: %q", b)
	}
	good, _ := os.ReadFile(p)
	for _, bad := range []string{
		`{"clientId":"Iv1.abc"}`,
		`{"clientSecret":"` + secret + `"}`,
		`{"clientId":"Iv1.abc","clientSecret":""}`,
		`{"clientId":"Iv1.abc","clientSecret":"two ` + secret + `"}`,
		`{"clientId":"Iv1.abc","clientSecret":"line\n` + secret + `"}`,
		`{"clientId":"Iv1.abc","clientSecret":"` + strings.Repeat("x", 4097) + `"}`,
		`{"clientId":"Iv1.abc","clientSecret":"caf\u00e9` + secret + `"}`,
		`{"clientId":"../../etc","clientSecret":"` + secret + `"}`,
		`{"clientId":"Iv1.abc","clientSecret":"` + secret + `","slug":"Example App"}`,
		`{"clientId":"Iv1.abc","clientSecret":"` + secret + `","slug":null}`,
		`{"clientId":"Iv1.abc","clientSecret":"` + secret + `","path":"/etc/shadow"}`,
		`{"clientId":"Iv1.abc","clientSecret":12}`,
		`["` + secret + `"]`, `not json ` + secret, ``,
	} {
		code, out, errs := tb.tctl(bad, "github-app-set", "--json")
		if code == 0 || out != "" || strings.Contains(errs, secret) {
			t.Fatalf("accepted or printed %.60s: %d %q %q", bad, code, out, errs)
		}
	}
	if b, _ := os.ReadFile(p); !bytes.Equal(b, good) {
		t.Fatal("a refused app replaced the file")
	}
	// the secret is never an argument
	if code, out, _ := tb.tctl(app, "github-app-set", "--json", "--client-secret", secret); code == 0 || out != "" {
		t.Fatal("took the secret as an argument")
	}
}

// github-app-set: Go's rules take every app the contract's vectors take and refuse every one they refuse; the
// largest app the contract takes fits stdin and gives a file app.ts reads (below 16 KiB).
func TestTenantGitHubAppVectors(t *testing.T) {
	skipAsRoot(t)
	b, err := os.ReadFile("../../../shared/src/cloud-protocol/vectors/vectors.json")
	must(t, err)
	var v struct {
		TenantCommands struct {
			Allowed []struct {
				Command string          `json:"command"`
				Stdin   json.RawMessage `json:"stdin"`
			} `json:"allowed"`
			Refused []struct {
				Command string          `json:"command"`
				Args    map[string]any  `json:"args"`
				Stdin   json.RawMessage `json:"stdin"`
				Why     string          `json:"why"`
			} `json:"refused"`
		} `json:"tenantCommands"`
	}
	must(t, json.Unmarshal(b, &v))
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{}
	f.install(t)
	n := 0
	for _, a := range v.TenantCommands.Allowed {
		if a.Command == "github-app-set" {
			n++
			if code, out, errs := tb.tctl(string(a.Stdin), "github-app-set", "--json"); code != 0 || !strings.Contains(out, `"ok":true`) {
				t.Fatalf("refused an allowed vector: %d %q %s", code, out, errs)
			}
			got, _ := os.ReadFile(filepath.Join(tb.base, githubAppFile))
			var want, have map[string]any
			_ = json.Unmarshal(a.Stdin, &want)
			if json.Unmarshal(got, &have) != nil || fmt.Sprint(have) != fmt.Sprint(want) {
				t.Fatalf("file %q for %s", got, a.Stdin)
			}
		}
	}
	for _, r := range v.TenantCommands.Refused {
		if r.Command != "github-app-set" || len(r.Args) > 0 {
			continue
		}
		n++
		if code, out, _ := tb.tctl(string(r.Stdin), "github-app-set", "--json"); code == 0 || out != "" {
			t.Fatalf("took a refused vector (%s): %q", r.Why, out)
		}
	}
	if n < 10 {
		t.Fatalf("only %d github-app-set vectors", n)
	}
	for _, c := range []string{`"`, `\`, `<`, `&`} {
		bb, _ := json.Marshal(map[string]string{"clientId": strings.Repeat("x", 128), "clientSecret": strings.Repeat(c, 4096), "slug": strings.Repeat("a", 100)})
		big := string(bb)
		if code, out, errs := tb.tctl(big, "github-app-set", "--json"); code != 0 || !strings.Contains(out, `"ok":true`) {
			t.Fatalf("the largest app (%s): %d %q %s", c, code, out, errs)
		}
		if st, _ := os.Stat(filepath.Join(tb.base, githubAppFile)); st.Size() >= 16384 {
			t.Fatalf("file of %d bytes for %s", st.Size(), c)
		}
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
		"owner-recovery-claimed": `{"ok":true,"cleared":true}`,
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
		{"", []string{"owner-recovery-claimed", "--json"}, []string{"owner-recovery-claimed"}, "cleared"},
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

func TestTenantHostedSpeechKeySet(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{adminOut: map[string]string{"hosted-speech-key": `{"ok":true,"set":true}`}}
	f.install(t)
	key := "sk-or-v1-" + strings.Repeat("0a", 32)
	code, out, errs := tb.tctl(`{"key":"`+key+`"}`, "hosted-speech-key-set", "--json")
	if code != 0 || len(f.adminCalls) != 1 || strings.Join(f.adminCalls[0], " ") != "hosted-speech-key" {
		t.Fatalf("%d %q %s %v", code, out, errs, f.adminCalls)
	}
	// the key goes on admin.js's stdin only: never in its argv, the answer or stderr
	if f.adminStdin[0] != `{"key":"`+key+`"}` || strings.Contains(out, key) || strings.Contains(errs, key) {
		t.Fatalf("key handling: stdin %q out %q err %q", f.adminStdin[0], out, errs)
	}
	if m := jsonOf(t, out); m["ok"] != true || m["set"] != true || f.restarts != 0 {
		t.Fatalf("answer %q, %d restarts", out, f.restarts)
	}
	// null takes it away
	f.adminOut["hosted-speech-key"] = `{"ok":true,"set":false}`
	if code, out, _ := tb.tctl(`{"key":null}`, "hosted-speech-key-set", "--json"); code != 0 || jsonOf(t, out)["set"] != false || f.adminStdin[1] != `{"key":null}` {
		t.Fatalf("null: %d %q %v", code, out, f.adminStdin)
	}
	// refused before admin.js runs
	f.adminCalls = nil
	for _, bad := range []string{``, `{}`, `{"key":"sk-or-short"}`, `{"key":"` + key + `","x":1}`, `{"key":1}`, `{"key":"` + key + `; rm -rf /"}`, `[1]`} {
		if code, out, errs := tb.tctl(bad, "hosted-speech-key-set", "--json"); code == 0 || out != "" || strings.Contains(errs, key) {
			t.Fatalf("accepted %q: %d %q %s", bad, code, out, errs)
		}
	}
	if len(f.adminCalls) != 0 {
		t.Fatalf("admin.js ran for refused stdin: %v", f.adminCalls)
	}
	// an admin.js answer without set is not passed on
	f.adminOut["hosted-speech-key"] = `{"ok":true}`
	if code, out, _ := tb.tctl(`{"key":null}`, "hosted-speech-key-set", "--json"); code == 0 || out != "" {
		t.Fatalf("an answer without set got through: %d %q", code, out)
	}
}

// error-reports-set: one MYCEL_ERROR_REPORT_URL line in /etc/default/<id>, every other line kept, idempotent, a restart
// only on a change and only when idle, a strict key shape, and the key never printed. Fake keys only.
func TestTenantErrorReportsSet(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{}
	f.install(t)
	defaultsDir = t.TempDir()
	t.Cleanup(func() { defaultsDir = "/etc/default" })
	p := filepath.Join(defaultsDir, "mycel")
	enroll := "# written by mycel-enroll\nMYCEL_TEAM_TZ=Asia/Seoul\nMYCEL_INSTALL_ID=01JC8Z5V3Q1X2Y3Z4A5B6C7D8E\nMYCEL_SAFE_OPS_1A=1\n"
	must(t, os.WriteFile(p, []byte(enroll), 0o644))
	// the server has run since before the file was written
	f.started, f.startKnown = time.Now().Add(-time.Hour), true
	keyA := "https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/1"
	keyB := "https://1111111111111111bbbbbbbbbbbbbbbb@o0.ingest.example.invalid:8443/prefix/42"
	set := func(stdin string) (map[string]any, string) {
		t.Helper()
		code, out, errs := tb.tctl(stdin, "error-reports-set", "--json")
		if code != 0 {
			t.Fatalf("%s: %d %q %s", stdin, code, out, errs)
		}
		for _, k := range []string{keyA, keyB, "0000000000000000aaaa", "1111111111111111bbbb"} {
			if strings.Contains(out, k) || strings.Contains(errs, k) {
				t.Fatalf("the key was printed: out %q err %q", out, errs)
			}
		}
		return jsonOf(t, out), errs
	}
	file := func() string { b, _ := os.ReadFile(p); return string(b) }

	// set: the other lines stay as they were, one line is added
	if m, _ := set(`{"url":"` + keyA + `"}`); m["ok"] != true || m["changed"] != true || m["restarted"] != true || f.restarts != 1 {
		t.Fatalf("set: %v, %d restarts", m, f.restarts)
	}
	if got := file(); got != enroll+"MYCEL_ERROR_REPORT_URL="+keyA+"\n" {
		t.Fatalf("set: %q", got)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", st.Mode())
	}
	// the same key again: nothing changes, no restart
	if m, _ := set(`{"url":"` + keyA + `"}`); m["changed"] != false || m["restarted"] != false || f.restarts != 1 {
		t.Fatalf("same key: %v, %d restarts", m, f.restarts)
	}
	// replace: in place, still one line
	if m, _ := set(`{"url":"` + keyB + `"}`); m["changed"] != true || m["restarted"] != true || f.restarts != 2 {
		t.Fatalf("replace: %v, %d restarts", m, f.restarts)
	}
	if got := file(); got != enroll+"MYCEL_ERROR_REPORT_URL="+keyB+"\n" {
		t.Fatalf("replace: %q", got)
	}
	// a line someone added after ours stays after it; a second copy of ours goes
	must(t, os.WriteFile(p, []byte(enroll+"MYCEL_ERROR_REPORT_URL="+keyB+"\nMYCEL_REMOTE_MCP_ORIGIN=https://mcp.example.invalid\nMYCEL_ERROR_REPORT_URL="+keyB+"\n"), 0o644))
	if m, _ := set(`{"url":"` + keyB + `"}`); m["changed"] != true {
		t.Fatalf("duplicate line: %v", m)
	}
	if got := file(); got != enroll+"MYCEL_ERROR_REPORT_URL="+keyB+"\nMYCEL_REMOTE_MCP_ORIGIN=https://mcp.example.invalid\n" {
		t.Fatalf("duplicate line: %q", got)
	}
	// busy: the line changes, the server is not restarted while an answer runs
	// (file times are coarse: the write must come visibly after the last restart)
	time.Sleep(20 * time.Millisecond)
	f.turns = []int{1}
	prevWait := errorReportsIdleWait
	errorReportsIdleWait = 0
	t.Cleanup(func() { errorReportsIdleWait = prevWait })
	restarts := f.restarts
	if m, errs := set(`{"url":"` + keyA + `"}`); m["changed"] != true || m["restarted"] != false || f.restarts != restarts || !strings.Contains(errs, "next start") {
		t.Fatalf("busy: %v %q, %d restarts", m, errs, f.restarts)
	}
	// the resend once idle: unchanged, but the server still runs with the old value, so it is restarted now
	f.turns = nil
	if m, _ := set(`{"url":"` + keyA + `"}`); m["changed"] != false || m["restarted"] != true || f.restarts != restarts+1 {
		t.Fatalf("resend after busy: %v, %d restarts", m, f.restarts-restarts)
	}
	// already current (the server started after the file's last change): no restart
	restarts = f.restarts
	if m, _ := set(`{"url":"` + keyA + `"}`); m["changed"] != false || m["restarted"] != false || f.restarts != restarts {
		t.Fatalf("already current: %v, %d restarts", m, f.restarts-restarts)
	}
	// no start time known (no systemd, no running server): no restart for an unchanged value
	f.startKnown = false
	if m, _ := set(`{"url":"` + keyA + `"}`); m["restarted"] != false || f.restarts != restarts {
		t.Fatalf("unknown start: %v", m)
	}
	f.startKnown = true
	// null while busy, then the resend: the server is restarted without the key
	time.Sleep(20 * time.Millisecond)
	f.turns = []int{1}
	if m, _ := set(`{"url":null}`); m["changed"] != true || m["restarted"] != false || f.restarts != restarts {
		t.Fatalf("null busy: %v", m)
	}
	if got := file(); got != enroll+"MYCEL_REMOTE_MCP_ORIGIN=https://mcp.example.invalid\n" {
		t.Fatalf("null: %q", got)
	}
	f.turns = nil
	if m, _ := set(`{"url":null}`); m["changed"] != false || m["restarted"] != true || f.restarts != restarts+1 {
		t.Fatalf("null resend after busy: %v", m)
	}
	restarts = f.restarts
	if m, _ := set(`{"url":null}`); m["changed"] != false || m["restarted"] != false || f.restarts != restarts {
		t.Fatalf("null again: %v", m)
	}
	// no file yet: set makes it, null takes the file away again
	must(t, os.Remove(p))
	if m, _ := set(`{"url":"` + keyA + `"}`); m["changed"] != true || file() != "MYCEL_ERROR_REPORT_URL="+keyA+"\n" {
		t.Fatalf("new file: %v %q", m, file())
	}
	// null on our line alone while busy removes the file; the resend still restarts (the folder's time)
	time.Sleep(20 * time.Millisecond)
	f.turns = []int{1}
	if m, _ := set(`{"url":null}`); m["changed"] != true || m["restarted"] != false {
		t.Fatalf("null on our line alone: %v", m)
	}
	if _, err := os.Stat(p); err == nil {
		t.Fatal("an empty defaults file was left behind")
	}
	f.turns = nil
	restarts = f.restarts
	if m, _ := set(`{"url":null}`); m["changed"] != false || m["restarted"] != true || f.restarts != restarts+1 {
		t.Fatalf("null resend, file gone: %v", m)
	}
	if m, _ := set(`{"url":null}`); m["restarted"] != false {
		t.Fatalf("null, file gone, current: %v", m)
	}
	// longer than the contract's 1000 characters: refused even when the shape matches
	long := "https://" + strings.Repeat("0", 128) + "@" + strings.Repeat("a", 63) + strings.Repeat("."+strings.Repeat("b", 63), 9) + ":8443" + strings.Repeat("/"+strings.Repeat("c", 64), 4) + "/" + strings.Repeat("1", 20)
	if len(long) <= 1000 || !sentryDsnRE.MatchString(long) {
		t.Fatalf("the long test key: %d characters, shape %v", len(long), sentryDsnRE.MatchString(long))
	}
	restarts = f.restarts
	if code, out, errs := tb.tctl(`{"url":"`+long+`"}`, "error-reports-set", "--json"); code == 0 || out != "" || strings.Contains(errs, long) {
		t.Fatalf("a key over 1000 characters: %d %q %s", code, out, errs)
	}
	if _, err := os.Stat(p); err == nil || f.restarts != restarts {
		t.Fatal("a key over 1000 characters was written")
	}

	// refused before anything is written: injection (newline, quote, backslash, space, =), other shapes, other stdin
	must(t, os.WriteFile(p, []byte(enroll), 0o644))
	restarts = f.restarts
	for _, bad := range []string{
		`{"url":"` + keyA + `\nNODE_OPTIONS=--require=/tmp/x.js"}`,
		`{"url":"` + keyA + `\r\nLD_PRELOAD=/tmp/x.so"}`,
		`{"url":"` + keyA + `\""}`,
		`{"url":"` + keyA + `'"}`,
		`{"url":"` + keyA + `\\"}`,
		`{"url":"` + keyA + ` x"}`,
		`{"url":"https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/1=2"}`,
		`{"url":"http://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/1"}`,
		`{"url":"https://errors.example.invalid/1"}`,
		`{"url":"https://0000000000000000aaaaaaaaaaaaaaaa:secret@errors.example.invalid/1"}`,
		`{"url":"https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/"}`,
		`{"url":"https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/abc"}`,
		`{"url":"https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/../1"}`,
		`{"url":""}`, `{"url":1}`, `{"url":"` + keyA + `","x":1}`, `{}`, `{"key":null}`, ``, `[1]`, `not json`,
	} {
		code, out, errs := tb.tctl(bad, "error-reports-set", "--json")
		if code == 0 || out != "" || strings.Contains(errs, "0000000000000000aaaa") {
			t.Fatalf("accepted or printed %q: %d %q %s", bad, code, out, errs)
		}
	}
	if file() != enroll || f.restarts != restarts {
		t.Fatalf("a refused value changed the file or restarted: %q, %d restarts", file(), f.restarts-restarts)
	}
	// the same pattern as the contract's SentryDsn
	src, err := os.ReadFile("../../../shared/src/cloud-protocol/tenant-commands.ts")
	must(t, err)
	if !strings.Contains(strings.ReplaceAll(string(src), `\/`, `/`), "regex(/"+sentryDsnRE.String()+"/)") {
		t.Fatal("sentryDsnRE and the contract's SentryDsn differ")
	}
}

// Writers of /etc/default/<id> at the same time keep each other's lines (the flock in setDefaultsLine).
func TestDefaultsLineLock(t *testing.T) {
	rootUID = os.Getuid()
	t.Cleanup(func() { rootUID = 0 })
	defaultsDir = t.TempDir()
	t.Cleanup(func() { defaultsDir = "/etc/default" })
	must(t, os.WriteFile(filepath.Join(defaultsDir, "mycel"), []byte("MYCEL_TEAM_TZ=Asia/Seoul\n"), 0o644))
	const n = 40
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			v := fmt.Sprint(i)
			_, err := setDefaultsLine("mycel", fmt.Sprintf("MYCEL_T%02d", i), &v)
			errs <- err
		}(i)
	}
	for i := 0; i < n; i++ {
		must(t, <-errs)
	}
	b, _ := os.ReadFile(filepath.Join(defaultsDir, "mycel"))
	for i := 0; i < n; i++ {
		if !strings.Contains(string(b), fmt.Sprintf("MYCEL_T%02d=%d\n", i, i)) {
			t.Fatalf("line %d lost:\n%s", i, b)
		}
	}
	if !strings.HasPrefix(string(b), "MYCEL_TEAM_TZ=Asia/Seoul\n") {
		t.Fatalf("first line lost:\n%s", b)
	}
	st, err := os.Stat(filepath.Join(defaultsDir, ".mycel.lock"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("lock file: %v %v", st, err)
	}
}

// The server's start time from a /proc: field 22 of <pid>/stat in ticks of 10 ms after btime; a comm with ") " in it
// does not shift the fields.
func TestProcStartTime(t *testing.T) {
	proc := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(proc, "4242"), 0o755))
	must(t, os.WriteFile(filepath.Join(proc, "stat"), []byte("cpu  1 2 3\nbtime 1763600000\nprocesses 9\n"), 0o644))
	fields := []string{"S", "1", "4242", "4242", "0", "-1", "4194560", "100", "0", "0", "0", "5", "3", "0", "0", "20", "0", "8", "0", "123456"}
	must(t, os.WriteFile(filepath.Join(proc, "4242", "stat"), []byte("4242 (bun ) x) "+strings.Join(fields, " ")+" 1000 2000\n"), 0o644))
	got, ok := procStartTime(proc, 4242)
	if want := time.Unix(1763600000, 0).Add(1234560 * time.Millisecond); !ok || !got.Equal(want) {
		t.Fatalf("got %v %v, want %v", got, ok, want)
	}
	if _, ok := procStartTime(proc, 1); ok {
		t.Fatal("a missing process has a start time")
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

// The optional onboarding block is opt-in by the reader (ax-hostd's TenantStatus is strict): without --onboarding the
// status keeps its exact earlier fields and admin.js is not asked to count; with it, the block passes with its known
// fields only, and a block that is null, partial, out of range or of the wrong type is dropped alone.
func TestTenantStatusOnboarding(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	app := `{"setupNeeded":false,"activeMembers":3,"queue":null,"relay":null,"lastLocalBackup":null,"lastUploadedLocalId":null,"overall":"ok","checks":[],"ai":{"claude":"ok","codex":"none"},"credentialsKey":{"present":true,"version":1},"onboarding":%s}`
	good := `{"day":2,"packInstalled":true,"profileSaved":false,"inviteMade":true,"membersJoined":2,"peopleAnswered":3,"membersWithFirstRun":2,"bestSkillRunners":2,"goalReached":false,"skillName":"ad-copy"}`
	f := &fakeTenant{adminOut: map[string]string{"cloud-status": fmt.Sprintf(app, good)}}
	f.install(t)
	// not asked: today's exact fields, and admin.js cloud-status without the flag
	code, out, errs := tb.tctl("", "status", "--json")
	if code != 0 {
		t.Fatalf("%d %s", code, errs)
	}
	var keys []string
	for k := range jsonOf(t, out) {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, " ") != "activeMembers ai app at checks credentialsKey kitVersion lastLocalBackup lastUploadedLocalId overall queue relay resources rootVersion setupNeeded update" {
		t.Fatalf("fields without --onboarding: %v", keys)
	}
	if last := f.adminCalls[len(f.adminCalls)-1]; strings.Join(last, " ") != "cloud-status" {
		t.Fatalf("admin.js %v", last)
	}
	// asked
	code, out, errs = tb.tctl("", "status", "--json", "--onboarding")
	if code != 0 {
		t.Fatalf("%d %s", code, errs)
	}
	if last := f.adminCalls[len(f.adminCalls)-1]; strings.Join(last, " ") != "cloud-status --onboarding" {
		t.Fatalf("admin.js %v", last)
	}
	o, ok := jsonOf(t, out)["onboarding"].(map[string]any)
	if !ok || len(o) != 9 || o["day"] != float64(2) || o["bestSkillRunners"] != float64(2) || o["packInstalled"] != true || strings.Contains(out, "ad-copy") {
		t.Fatalf("onboarding %s", out)
	}
	full := `"day":1,"packInstalled":true,"profileSaved":false,"inviteMade":true,"membersJoined":2,"peopleAnswered":3,"membersWithFirstRun":2,"bestSkillRunners":2`
	for _, bad := range []string{
		`null`, `"x"`, `{}`, `{"day":1.5}`,
		`{` + full + `}`, // goalReached missing: not zero-filled
		`{` + full + `,"goalReached":null}`,
		`{"day":-1,"packInstalled":true,"profileSaved":false,"inviteMade":true,"membersJoined":2,"peopleAnswered":3,"membersWithFirstRun":2,"bestSkillRunners":2,"goalReached":false}`,
		`{"day":1,"packInstalled":"yes","profileSaved":false,"inviteMade":true,"membersJoined":2,"peopleAnswered":3,"membersWithFirstRun":2,"bestSkillRunners":2,"goalReached":false}`,
	} {
		f.adminOut["cloud-status"] = fmt.Sprintf(app, bad)
		code, out, _ = tb.tctl("", "status", "--json", "--onboarding")
		s := jsonOf(t, out)
		if _, has := s["onboarding"]; code != 0 || has || s["activeMembers"] != float64(3) || s["overall"] != "ok" {
			t.Fatalf("%s: %d %s", bad, code, out)
		}
	}
}

// Every argv of the contract's vectors (shared/src/cloud-protocol/vectors/vectors.json) parses here.
func TestTenantArgvVectors(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{adminOut: map[string]string{"relay-key": `{"publicKey":"PK","sig":"S"}`, "reset-link": `{"url":"https://a.b/c","expiresAt":"x"}`, "cloud-backup": `{"localId":"20261022T020000Z-daily"}`, "cloud-status": `{}`}}
	f.install(t)
	// data-grow runs findmnt and resize2fs
	oldF, oldR := findmntBin, resize2fsBin
	t.Cleanup(func() { findmntBin, resize2fsBin = oldF, oldR })
	findmntBin, resize2fsBin = filepath.Join(tb.fakeBin, "findmnt"), filepath.Join(tb.fakeBin, "resize2fs")
	must(t, os.WriteFile(findmntBin, []byte("#!/bin/sh\necho /dev/nvme1n1\n"), 0o755))
	must(t, os.WriteFile(resize2fsBin, []byte("#!/bin/sh\nexit 0\n"), 0o755))
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

// reset-link after a handover (admin.js exit 3, owner_recovery_locked): mycel-ctl exits 3 with the code on stderr and
// prints nothing, so the control plane tells it from a failure; any other admin.js failure stays exit 1.
func TestTenantResetLinkLocked(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{adminOut: map[string]string{}, adminErr: adminExit{code: 3, msg: "admin.js reset-link: exit status 3: error: owner_recovery_locked"}}
	f.install(t)
	code, out, errs := tb.tctl("", "reset-link", "--json", "--owner")
	if code != 3 || out != "" || !strings.Contains(errs, "owner_recovery_locked") {
		t.Fatalf("locked: %d %q %s", code, out, errs)
	}
	f.adminErr = adminExit{code: 1, msg: "admin.js reset-link: exit status 1: boom"}
	if code, _, _ := tb.tctl("", "reset-link", "--json", "--username", "kim"); code != 1 {
		t.Fatalf("other failure: %d", code)
	}
}

// mail-in-set: the MYCEL_MAIL_IN_URL and MYCEL_MAIL_IN_DOMAIN lines of /etc/default/<id>, every other line kept, both
// or neither, idempotent, a restart only on a change and only when idle, strict shapes (no line injection).
func TestTenantMailInSet(t *testing.T) {
	tb := newTestBase(t, "0.3.0")
	f := &fakeTenant{}
	f.install(t)
	defaultsDir = t.TempDir()
	t.Cleanup(func() { defaultsDir = "/etc/default" })
	prevWait := errorReportsIdleWait
	errorReportsIdleWait = 0
	t.Cleanup(func() { errorReportsIdleWait = prevWait })
	p := filepath.Join(defaultsDir, "mycel")
	enroll := "# written by mycel-enroll\nMYCEL_TEAM_TZ=Asia/Seoul\nMYCEL_ERROR_REPORT_URL=https://0000000000000000aaaaaaaaaaaaaaaa@errors.example.invalid/1\n"
	must(t, os.WriteFile(p, []byte(enroll), 0o644))
	f.started, f.startKnown = time.Now().Add(-time.Hour), true
	set := func(stdin string) map[string]any {
		t.Helper()
		code, out, errs := tb.tctl(stdin, "mail-in-set", "--json")
		if code != 0 {
			t.Fatalf("%s: %d %q %s", stdin, code, out, errs)
		}
		return jsonOf(t, out)
	}
	file := func() string { b, _ := os.ReadFile(p); return string(b) }
	on := `{"url":"https://abc123.lambda-url.us-east-1.on.aws","domain":"in.trina.app"}`
	lines := "MYCEL_MAIL_IN_URL=https://abc123.lambda-url.us-east-1.on.aws\nMYCEL_MAIL_IN_DOMAIN=in.trina.app\n"

	if m := set(on); m["ok"] != true || m["changed"] != true || m["restarted"] != true || f.restarts != 1 {
		t.Fatalf("set: %v, %d restarts", m, f.restarts)
	}
	if got := file(); got != enroll+lines {
		t.Fatalf("set: %q", got)
	}
	// the same values again: nothing, no restart
	if m := set(on); m["changed"] != false || m["restarted"] != false || f.restarts != 1 {
		t.Fatalf("same: %v, %d restarts", m, f.restarts)
	}
	// another domain only: changed in place
	if m := set(`{"url":"https://abc123.lambda-url.us-east-1.on.aws","domain":"in.example.com"}`); m["changed"] != true || f.restarts != 2 {
		t.Fatalf("domain: %v", m)
	}
	if got := file(); got != enroll+"MYCEL_MAIL_IN_URL=https://abc123.lambda-url.us-east-1.on.aws\nMYCEL_MAIL_IN_DOMAIN=in.example.com\n" {
		t.Fatalf("domain: %q", got)
	}
	// busy: written, not restarted; the resend restarts
	time.Sleep(20 * time.Millisecond)
	f.turns = []int{1}
	restarts := f.restarts
	if m := set(`{"url":null,"domain":null}`); m["changed"] != true || m["restarted"] != false || f.restarts != restarts {
		t.Fatalf("off busy: %v", m)
	}
	if got := file(); got != enroll {
		t.Fatalf("off: %q", got)
	}
	f.turns = nil
	if m := set(`{"url":null,"domain":null}`); m["changed"] != false || m["restarted"] != true || f.restarts != restarts+1 {
		t.Fatalf("off resend: %v", m)
	}
	if m := set(`{"url":null,"domain":null}`); m["changed"] != false || m["restarted"] != false {
		t.Fatalf("off again: %v", m)
	}
	// refused before anything is written
	restarts = f.restarts
	for _, bad := range []string{
		`{"url":"https://mail.example.invalid\nNODE_OPTIONS=--require=/tmp/x.js","domain":"in.example.invalid"}`,
		`{"url":"https://mail.example.invalid","domain":"in.example.invalid\nLD_PRELOAD=/tmp/x.so"}`,
		`{"url":"https://mail.example.invalid\"","domain":"in.example.invalid"}`,
		`{"url":"https://mail.example.invalid/","domain":"in.example.invalid"}`,
		`{"url":"https://mail.example.invalid/api","domain":"in.example.invalid"}`,
		`{"url":"http://mail.example.invalid","domain":"in.example.invalid"}`,
		`{"url":"https://Mail.example.invalid","domain":"in.example.invalid"}`,
		`{"url":"https://u@mail.example.invalid","domain":"in.example.invalid"}`,
		`{"url":"https://mail.example.invalid x","domain":"in.example.invalid"}`,
		`{"url":"https://mail.example.invalid","domain":"localhost"}`,
		`{"url":"https://mail.example.invalid","domain":"in.example.invalid="}`,
		`{"url":"https://mail.example.invalid","domain":null}`,
		`{"url":null,"domain":"in.example.invalid"}`,
		`{"url":"https://mail.example.invalid"}`,
		`{"url":null,"domain":null,"x":1}`, `{}`, ``, `[1]`, `not json`,
	} {
		if code, out, _ := tb.tctl(bad, "mail-in-set", "--json"); code == 0 || out != "" {
			t.Fatalf("accepted %q: %d %q", bad, code, out)
		}
	}
	if file() != enroll || f.restarts != restarts {
		t.Fatalf("a refused value changed the file or restarted: %q", file())
	}
	// the same patterns as the contract's MailInOrigin and MailInDomain
	src, err := os.ReadFile("../../../shared/src/cloud-protocol/tenant-commands.ts")
	must(t, err)
	c := strings.ReplaceAll(string(src), `\/`, `/`)
	if !strings.Contains(c, "regex(/"+mailInOriginRE.String()+"/)") || !strings.Contains(c, "regex(/"+mailInDomainRE.String()+"/)") {
		t.Fatal("the mail-in patterns and the contract's MailInOrigin / MailInDomain differ")
	}
}
