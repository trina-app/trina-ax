package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/age"
	"filippo.io/age/armor"
)

const testTenant = "01JC8ZK3Q4M5N6P7R8S9T0V1W2"

// ---------- fakes ----------

type call struct {
	name  string
	args  []string
	stdin string
}

// fakeRunner records every command and simulates the few system tools mycel-enroll uses. cp runs for real.
type fakeRunner struct {
	mu        sync.Mutex
	t         *testing.T
	calls     []call
	labelDev  string            // what `blkid -L axdata` prints ("" = exit 2)
	probe     map[string]string // `blkid -p DEV` output ("" or missing = exit 2, no signature)
	lsblk     string
	mounted   *bool
	adminFn   func(args []string) ([]byte, error)
	failNames map[string]error
}

func (f *fakeRunner) Run(ctx context.Context, name string, args []string, stdin []byte) ([]byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, call{name: name, args: append([]string(nil), args...), stdin: string(stdin)})
	f.mu.Unlock()
	if err, ok := f.failNames[filepath.Base(name)]; ok {
		return nil, err
	}
	switch {
	case name == "cp":
		out, err := exec.Command("cp", args...).CombinedOutput()
		if err != nil {
			return nil, &CmdError{Name: "cp", Code: 1, Stderr: string(out)}
		}
		return nil, nil
	case name == "blkid" && args[0] == "-L":
		if f.labelDev == "" {
			return nil, &CmdError{Name: "blkid", Code: 2}
		}
		return []byte(f.labelDev + "\n"), nil
	case name == "blkid" && args[0] == "-p":
		if s := f.probe[args[1]]; s != "" {
			return []byte(s), nil
		}
		return nil, &CmdError{Name: "blkid", Code: 2}
	case name == "lsblk":
		return []byte(f.lsblk), nil
	case name == "mkfs.ext4":
		f.labelDev = args[len(args)-1]
		return nil, nil
	case name == "mount":
		*f.mounted = true
		return nil, nil
	case name == "systemctl":
		return nil, nil
	case name == "runuser":
		if f.adminFn != nil {
			return f.adminFn(args)
		}
		return nil, nil
	case strings.HasSuffix(name, "/root/mycel-ctl"):
		return []byte(`{"ok":true}`), nil
	}
	f.t.Fatalf("unexpected command %s %v", name, args)
	return nil, nil
}

func (f *fakeRunner) named(n string) []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []call
	for _, c := range f.calls {
		if c.name == n || filepath.Base(c.name) == n {
			out = append(out, c)
		}
	}
	return out
}

type harness struct {
	t       *testing.T
	root    string
	e       *Enroller
	run     *fakeRunner
	mounted bool
	chowned map[string][2]int
	sleeps  []time.Duration
	steps   []string
	env     map[string]string
	out     *bytes.Buffer
}

// newHarness builds a fake machine in a temp folder: a seed made like the kit's image mode, an existing
// /etc/default/mycel, /etc/cloud, and an enroll.json for mode (nil cfg = standalone).
func newHarness(t *testing.T) *harness {
	t.Helper()
	root := t.TempDir()
	h := &harness{t: t, root: root, chowned: map[string][2]int{}, env: map[string]string{}, out: &bytes.Buffer{}}
	seed := filepath.Join(root, "seed")
	must(t, os.MkdirAll(filepath.Join(seed, "root"), 0o755))
	must(t, os.WriteFile(filepath.Join(seed, "root", "VERSION"), []byte("0.3.0\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(seed, "root", "mycel-ctl"), []byte("#!/bin/sh\n"), 0o755))
	must(t, os.MkdirAll(filepath.Join(seed, "config"), 0o700))
	must(t, os.WriteFile(filepath.Join(seed, "config", "server.json"), []byte(`{"mode":"prod","listen":{"host":"127.0.0.1","port":47820},
"engine":{"authMode":"subscription","proxyPort":47821},"relay":{"url":null,"teamName":null,"officialAvailable":false},"custom":{"keep":12345678901234567890}}`), 0o600))
	must(t, os.MkdirAll(filepath.Join(seed, "data"), 0o700))
	must(t, os.MkdirAll(filepath.Join(seed, "secrets"), 0o700))
	appv := filepath.Join(seed, "app", "versions", "0.3.0")
	must(t, os.MkdirAll(filepath.Join(appv, "bin"), 0o755))
	must(t, os.MkdirAll(filepath.Join(appv, "server", "src"), 0o755))
	must(t, os.WriteFile(filepath.Join(appv, "bin", "bun"), nil, 0o755))
	must(t, os.WriteFile(filepath.Join(appv, "server", "src", "admin.js"), nil, 0o644))
	must(t, os.Symlink("versions/0.3.0", filepath.Join(seed, "app", "current")))
	must(t, os.MkdirAll(filepath.Join(root, "etc", "default"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "etc", "default", "mycel"), []byte("# kept\nFOO=bar\nMYCEL_TEAM_TZ=UTC\n"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "etc", "cloud"), 0o755))
	must(t, os.MkdirAll(filepath.Join(root, "run"), 0o755))

	h.run = &fakeRunner{t: t, probe: map[string]string{}, mounted: &h.mounted, failNames: map[string]error{}}
	h.e = &Enroller{
		P: Paths{
			EnrollFile: filepath.Join(root, "run", "enroll.json"), StatusFile: filepath.Join(root, "run", "enroll-status.json"),
			Base: filepath.Join(root, "base"), Seed: seed, DefaultFile: filepath.Join(root, "etc", "default", "mycel"),
			CloudInitDisabled: filepath.Join(root, "etc", "cloud", "cloud-init.disabled"), ServerUser: "axserver",
		},
		O:            Options{DataDevice: "auto", Units: defaultUnits},
		Run:          h.run,
		HTTP:         http.DefaultClient,
		Now:          time.Now,
		Sleep:        func(d time.Duration) { h.sleeps = append(h.sleeps, d) },
		IsMountpoint: func(p string) bool { return h.mounted },
		Systemd:      true,
		LookupUser: func(n string) (int, int, error) {
			if n != "axserver" {
				t.Fatalf("lookup %s", n)
			}
			return 990, 990, nil
		},
		Chown:         func(p string, u, g int) error { h.chowned[finalName(p)] = [2]int{u, g}; return nil },
		Getenv:        func(k string) string { return h.env[k] },
		Out:           h.out,
		RetryDeadline: 5 * time.Minute,
	}
	return h
}

func (h *harness) writeEnroll(mode, cp string) {
	h.t.Helper()
	cfg := map[string]any{"v": 1, "tenantId": testTenant, "controlPlane": cp, "enrollToken": "ent_abcdefghijklmnopqrstu", "mode": mode,
		"teamSlug": "acme", "relayTeamId": nil, "timeZone": "Asia/Seoul", "locale": "ko", "backupWindowStartMin": 150, "maintenanceWindowStartMin": 270}
	if mode == "restore" {
		cfg["relayTeamId"] = "team_123"
	}
	if mode == "reattach" {
		cfg["enrollToken"] = nil
	}
	b, _ := json.Marshal(cfg)
	must(h.t, os.WriteFile(h.e.P.EnrollFile, b, 0o600))
}

func (h *harness) status() statusFile {
	h.t.Helper()
	var s statusFile
	b, err := os.ReadFile(h.e.P.StatusFile)
	must(h.t, err)
	must(h.t, json.Unmarshal(b, &s))
	return s
}

func (h *harness) read(rel string) string {
	h.t.Helper()
	b, err := os.ReadFile(filepath.Join(h.e.P.Base, rel))
	must(h.t, err)
	return string(b)
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func modeOf(t *testing.T, p string) os.FileMode {
	t.Helper()
	st, err := os.Stat(p)
	must(t, err)
	return st.Mode().Perm()
}

// ---------- fake control plane ----------

type fakeCP struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	requests []map[string]any
	fail     []int // status codes for the first attempts
	teamID   *age.X25519Identity
	objects  map[string][]byte // name -> stored (encrypted) bytes
	badSha   bool
	kinds    any // engine.credentialKinds in the answer (nil = absent)
	verify   map[string]any
}

func newFakeCP(t *testing.T) *fakeCP {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	must(t, err)
	cp := &fakeCP{t: t, teamID: id, objects: map[string][]byte{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /enroll", cp.enroll)
	mux.HandleFunc("GET /obj/{name}", func(w http.ResponseWriter, r *http.Request) {
		b, ok := cp.objects[r.PathValue("name")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	})
	cp.srv = httptest.NewTLSServer(mux)
	t.Cleanup(cp.srv.Close)
	return cp
}

func ageEncrypt(t *testing.T, plain []byte, r age.Recipient, armored bool) []byte {
	t.Helper()
	var buf bytes.Buffer
	var dst io.Writer = &buf
	var aw io.WriteCloser
	if armored {
		aw = armor.NewWriter(&buf)
		dst = aw
	}
	w, err := age.Encrypt(dst, r)
	must(t, err)
	_, err = w.Write(plain)
	must(t, err)
	must(t, w.Close())
	if aw != nil {
		must(t, aw.Close())
	}
	return buf.Bytes()
}

func (cp *fakeCP) addObject(name string, plain []byte) {
	cp.objects[name] = ageEncrypt(cp.t, plain, cp.teamID.Recipient(), false)
}

func (cp *fakeCP) enroll(w http.ResponseWriter, r *http.Request) {
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", 400)
		return
	}
	cp.mu.Lock()
	cp.requests = append(cp.requests, req)
	n := len(cp.requests)
	cp.mu.Unlock()
	if n <= len(cp.fail) {
		w.WriteHeader(cp.fail[n-1])
		w.Write([]byte(`{"error":{"code":"token_invalid","message":"enroll token already used"}}`))
		return
	}
	mode := req["mode"].(string)
	resp := map[string]any{
		"v": 1,
		"server": map[string]any{
			"deployment":    "hosted",
			"relay":         map[string]any{"url": "wss://relay.treesoop.com/connect", "teamName": "acme"},
			"publicOrigins": []string{"https://acme.treesoop.com"},
			"engine":        map[string]any{},
		},
		"relayRegistration": map[string]any{"relayApi": "https://relay.treesoop.com", "teamId": "team_123", "teamName": "acme", "publicKey": req["relayPublicKey"], "address": "https://acme.treesoop.com"},
		"setupToken":        nil,
		"plan":              map[string]any{"format": 1, "planId": "team", "maxConcurrency": 3},
		"notices":           map[string]any{"format": 1, "notices": []any{}},
		"restore":           nil,
	}
	if cp.kinds != nil {
		resp["server"].(map[string]any)["engine"].(map[string]any)["credentialKinds"] = cp.kinds
	}
	if mode == "new" {
		resp["setupToken"] = "stp_" + strings.Repeat("x", 30)
	}
	if mode == "restore" || mode == "verify" {
		rcpt, err := age.ParseX25519Recipient(req["oneTimeRecipient"].(string))
		if err != nil {
			http.Error(w, "bad recipient", 400)
			return
		}
		idAge := ageEncrypt(cp.t, []byte(cp.teamID.String()+"\n"), rcpt, true)
		var objs []map[string]any
		for _, name := range []string{"db.sqlite.age", "team.tar.zst.age"} {
			b := cp.objects[name]
			sum := sha256.Sum256(b)
			sha := hex.EncodeToString(sum[:])
			if cp.badSha && name == "team.tar.zst.age" {
				sha = strings.Repeat("0", 64)
			}
			objs = append(objs, map[string]any{"name": name, "url": cp.srv.URL + "/obj/" + name, "sha256": sha, "size": len(b)})
		}
		restore := map[string]any{
			"chain":       []any{map[string]any{"backupId": "bk_0001", "objects": objs}},
			"identityAge": string(idAge),
			"expect":      nil,
		}
		key := bytes.Repeat([]byte{7}, 32)
		if mode == "restore" {
			restore["credentialsKeyAge"] = base64.StdEncoding.EncodeToString(ageEncrypt(cp.t, key, rcpt, false))
		} else {
			restore["credentialsKeyAge"] = nil
			restore["expect"] = map[string]any{"files": 2, "bytes": 10, "schemaVersion": 105}
		}
		resp["restore"] = restore
		resp["relayRegistration"] = nil
		if mode == "verify" {
			resp["server"] = map[string]any{"deployment": "hosted", "relay": nil, "publicOrigins": []string{}, "engine": map[string]any{}}
		}
	}
	w.Header().Set("content-type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (h *harness) useCP(cp *fakeCP) { h.e.HTTP = cp.srv.Client() }

// ---------- tests ----------

func TestNewMode(t *testing.T) {
	h := newHarness(t)
	cp := newFakeCP(t)
	h.useCP(cp)
	h.writeEnroll("new", cp.srv.URL)
	h.mounted = true // the image's mount unit already mounted the data disk
	var steps []string
	h.e.StatusHook = func(s statusFile) { steps = append(steps, s.State+":"+s.Step) }
	must(t, h.e.Main())

	want := []string{"running:read-config", "running:data-disk", "running:seed", "running:relay-key", "running:enroll", "running:apply", "running:start", "running:done", "ok:done"}
	if strings.Join(steps, ",") != strings.Join(want, ",") {
		t.Fatalf("status transitions\n got %v\nwant %v", steps, want)
	}
	st := h.status()
	if st.State != "ok" || st.Mode != "new" || st.KitVersion == nil || *st.KitVersion != "0.3.0" || st.Error != nil {
		t.Fatalf("status %+v", st)
	}
	// one request with a register proof that verifies with the key the VM kept
	if len(cp.requests) != 1 {
		t.Fatalf("%d requests", len(cp.requests))
	}
	req := cp.requests[0]
	if req["enrollToken"] != "ent_abcdefghijklmnopqrstu" || req["kitVersion"] != "0.3.0" || req["appVersion"] != "0.3.0" || req["oneTimeRecipient"] != nil {
		t.Fatalf("request %v", req)
	}
	pubB64 := req["relayPublicKey"].(string)
	proof := req["relayProof"].(map[string]any)
	spki, _ := base64.StdEncoding.DecodeString(pubB64)
	pk, err := x509.ParsePKIXPublicKey(spki)
	must(t, err)
	sig, _ := base64.StdEncoding.DecodeString(proof["sig"].(string))
	ts := int64(proof["ts"].(float64))
	if proof["kind"] != "register" || !ed25519.Verify(pk.(ed25519.PublicKey), []byte(registerSigningString("acme", pubB64, ts)), sig) {
		t.Fatalf("register proof does not verify: %v", proof)
	}
	keyFile := filepath.Join(h.e.P.Base, "data", "relay", "team-key.pem")
	k, err := parseRelayKey([]byte(h.read("data/relay/team-key.pem")))
	must(t, err)
	if k.pubB64 != pubB64 || modeOf(t, keyFile) != 0o600 {
		t.Fatalf("team key mismatch or mode %v", modeOf(t, keyFile))
	}
	blk, _ := pem.Decode([]byte(h.read("data/relay/team-key.pem")))
	if blk.Type != "PRIVATE KEY" {
		t.Fatal("not PKCS#8 PEM")
	}

	// setup token 0600 + owner
	tok := filepath.Join(h.e.P.Base, "data", "setup-token")
	if h.read("data/setup-token") != "stp_"+strings.Repeat("x", 30)+"\n" || modeOf(t, tok) != 0o600 || h.chowned[tok] != [2]int{990, 990} {
		t.Fatalf("setup-token %q mode %v owner %v", h.read("data/setup-token"), modeOf(t, tok), h.chowned[tok])
	}
	// server.json merged, unknown keys and big numbers kept, default credential kinds (API keys only)
	var sj map[string]any
	dec := json.NewDecoder(strings.NewReader(h.read("config/server.json")))
	dec.UseNumber()
	must(t, dec.Decode(&sj))
	if sj["deployment"] != "hosted" || sj["mode"] != "prod" {
		t.Fatalf("server.json %v", sj)
	}
	if sj["custom"].(map[string]any)["keep"].(json.Number).String() != "12345678901234567890" {
		t.Fatalf("unknown key / number not kept: %v", sj["custom"])
	}
	rel := sj["relay"].(map[string]any)
	if rel["url"] != "wss://relay.treesoop.com/connect" || rel["teamName"] != "acme" || rel["officialAvailable"] != false {
		t.Fatalf("relay %v", rel)
	}
	eng := sj["engine"].(map[string]any)
	if eng["authMode"] != "managed" || eng["proxyPort"].(json.Number).String() != "47821" {
		t.Fatalf("engine: managed mode (the seed said the older name subscription), proxy port kept: %v", eng)
	}
	kinds, _ := json.Marshal(eng["credentialKinds"])
	if string(kinds) != `["anthropic-oauth","anthropic-api-key","chatgpt","openai-api-key"]` {
		t.Fatalf("credentialKinds %s", kinds)
	}
	if o := sj["publicOrigins"].([]any); len(o) != 1 || o[0] != "https://acme.treesoop.com" {
		t.Fatalf("publicOrigins %v", o)
	}
	if modeOf(t, filepath.Join(h.e.P.Base, "config", "server.json")) != 0o600 {
		t.Fatal("server.json mode")
	}
	// /etc/default/mycel: our keys replaced, others kept
	def, _ := os.ReadFile(h.e.P.DefaultFile)
	if string(def) != "# kept\nFOO=bar\nMYCEL_TEAM_TZ=Asia/Seoul\nMYCEL_INSTALL_ID="+testTenant+"\nMYCEL_BACKUP_WINDOW_START_MIN=150\nMYCEL_MAINTENANCE_WINDOW_START_MIN=270\n" {
		t.Fatalf("/etc/default/mycel:\n%s", def)
	}
	// registration.json
	var reg map[string]any
	must(t, json.Unmarshal([]byte(h.read("data/relay/registration.json")), &reg))
	if reg["teamId"] != "team_123" || reg["publicKey"] != pubB64 {
		t.Fatalf("registration %v", reg)
	}
	// plan and notices through mycel-ctl
	ctl := h.run.named("mycel-ctl")
	if len(ctl) != 2 || ctl[0].args[0] != "apply-plan" || ctl[0].args[1] != "--json" || !strings.Contains(ctl[0].stdin, `"planId":"team"`) ||
		ctl[1].args[0] != "notices-set" || !strings.Contains(ctl[1].stdin, `"notices":[]`) {
		t.Fatalf("mycel-ctl calls %+v", ctl)
	}
	// units started, cloud-init disabled, enroll.json removed, never formatted
	sc := h.run.named("systemctl")
	if len(sc) != 1 || strings.Join(sc[0].args, " ") != "enable --now mycel-firewall.timer mycel-launcher.service mycel-server.service" {
		t.Fatalf("systemctl %+v", sc)
	}
	if !exists(h.e.P.CloudInitDisabled) || exists(h.e.P.EnrollFile) {
		t.Fatal("cloud-init not disabled or enroll.json left")
	}
	if len(h.run.named("mkfs.ext4")) != 0 || len(h.run.named("mount")) != 0 {
		t.Fatal("formatted or mounted although BASE was a mount point")
	}
}

func TestNewModeExplicitKindsAndRetriedEnrollKeepsKey(t *testing.T) {
	h := newHarness(t)
	cp := newFakeCP(t)
	cp.kinds = []string{"anthropic-oauth", "anthropic-api-key", "chatgpt", "openai-api-key"}
	cp.fail = []int{503, 502}
	h.useCP(cp)
	h.writeEnroll("new", cp.srv.URL)
	h.mounted = true
	must(t, h.e.Main())
	if len(cp.requests) != 3 || len(h.sleeps) != 2 || h.sleeps[0] != time.Second || h.sleeps[1] != 2*time.Second {
		t.Fatalf("requests %d sleeps %v", len(cp.requests), h.sleeps)
	}
	// all attempts carry the same relay key (made once)
	if cp.requests[0]["relayPublicKey"] != cp.requests[2]["relayPublicKey"] {
		t.Fatal("relay key changed between attempts")
	}
	if !strings.Contains(h.read("config/server.json"), `"chatgpt"`) {
		t.Fatal("explicit credentialKinds from the CP not written")
	}
	if h.status().State != "ok" {
		t.Fatal("not ok")
	}
}

func TestEnroll4xxFails(t *testing.T) {
	h := newHarness(t)
	cp := newFakeCP(t)
	cp.fail = []int{401}
	h.useCP(cp)
	h.writeEnroll("new", cp.srv.URL)
	h.mounted = true
	err := h.e.Main()
	if err == nil {
		t.Fatal("expected failure")
	}
	st := h.status()
	if st.State != "failed" || st.Step != "enroll" || st.Error == nil || st.Error.Code != "enroll_failed" || !strings.Contains(st.Error.Message, "401") || !strings.Contains(st.Error.Message, "token_invalid") {
		t.Fatalf("status %+v %+v", st, st.Error)
	}
	if len(cp.requests) != 1 || len(h.sleeps) != 0 {
		t.Fatal("a 4xx must not be retried")
	}
	if !exists(h.e.P.EnrollFile) || exists(filepath.Join(h.e.P.Base, "data", "setup-token")) || len(h.run.named("systemctl")) != 0 {
		t.Fatal("a failed enroll must not apply or start anything")
	}
}

func TestEnroll5xxUntilDeadlineFails(t *testing.T) {
	h := newHarness(t)
	cp := newFakeCP(t)
	cp.fail = []int{500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500}
	h.useCP(cp)
	h.writeEnroll("new", cp.srv.URL)
	h.mounted = true
	now := time.Now()
	h.e.Now = func() time.Time { return now }
	h.e.Sleep = func(d time.Duration) { h.sleeps = append(h.sleeps, d); now = now.Add(d) }
	if err := h.e.Main(); err == nil {
		t.Fatal("expected failure after the retry deadline")
	}
	var total time.Duration
	for _, s := range h.sleeps {
		total += s
		if s > 30*time.Second {
			t.Fatalf("backoff above 30 s: %v", s)
		}
	}
	if total > 5*time.Minute || total < 4*time.Minute {
		t.Fatalf("retried for %v", total)
	}
	if h.status().Error.Code != "enroll_failed" {
		t.Fatal(h.status().Error)
	}
}

func TestInsecureURL(t *testing.T) {
	h := newHarness(t)
	for _, c := range []struct {
		url, env string
		ok       bool
	}{
		{"https://cp.treesoop.com", "", true},
		{"http://cp.treesoop.com", "", false},
		{"http://cp.treesoop.com", "1", true},
		{"http://127.0.0.1:9999", "", true},
		{"http://[::1]:9999/x", "", true},
		{"http://localhost:9999", "", true},
		{"ftp://cp.treesoop.com", "1", false},
		{"https://user:pw@cp.treesoop.com", "", false},
	} {
		h.env["AX_ENROLL_ALLOW_HTTP"] = c.env
		err := h.e.checkURL(c.url)
		if (err == nil) != c.ok {
			t.Errorf("%s env=%q: err=%v", c.url, c.env, err)
		}
	}
	// and in the flow: refused before anything else happens
	h.env["AX_ENROLL_ALLOW_HTTP"] = ""
	h.writeEnroll("new", "http://cp.example.com")
	h.mounted = true
	if err := h.e.Main(); err == nil || h.status().Error.Code != "insecure_url" || h.status().Step != "read-config" {
		t.Fatalf("http CP accepted: %v %+v", err, h.status())
	}
}

func TestBadConfigRefused(t *testing.T) {
	h := newHarness(t)
	must(t, os.WriteFile(h.e.P.EnrollFile, []byte(`{"v":1,"tenantId":"x","mode":"new","extra":1}`), 0o600))
	if err := h.e.Main(); err == nil || h.status().Error.Code != "config_invalid" {
		t.Fatal("bad enroll.json accepted")
	}
}

func TestRestoreMode(t *testing.T) {
	h := newHarness(t)
	cp := newFakeCP(t)
	cp.addObject("db.sqlite.age", []byte("SQLITE-DB"))
	cp.addObject("team.tar.zst.age", []byte("TEAM"))
	h.useCP(cp)
	h.writeEnroll("restore", cp.srv.URL)
	h.mounted = true
	var sawStaging string
	h.run.adminFn = func(args []string) ([]byte, error) {
		// runuser -u axserver -- env -i … bun admin.js restore-artifacts --dir D --to BASE
		if args[0] != "-u" || args[1] != "axserver" || args[2] != "--" || args[3] != "env" || args[4] != "-i" {
			t.Fatalf("not run as the server account: %v", args)
		}
		i := indexOf(args, "restore-artifacts")
		if i < 0 || !strings.HasSuffix(args[i-1], "admin.js") || args[i+1] != "--dir" || args[i+3] != "--to" || args[i+4] != h.e.P.Base {
			t.Fatalf("admin args %v", args)
		}
		sawStaging = args[i+2]
		db, err := os.ReadFile(filepath.Join(sawStaging, "bk_0001", "db.sqlite"))
		if err != nil || string(db) != "SQLITE-DB" {
			t.Fatalf("decrypted db: %q %v", db, err)
		}
		team, _ := os.ReadFile(filepath.Join(sawStaging, "bk_0001", "team.tar.zst"))
		chain, _ := os.ReadFile(filepath.Join(sawStaging, "chain.json"))
		if string(team) != "TEAM" || !strings.Contains(string(chain), `"bk_0001"`) {
			t.Fatalf("team %q chain %s", team, chain)
		}
		if h.chowned[filepath.Join(sawStaging, "bk_0001", "db.sqlite")] != [2]int{990, 990} {
			t.Fatal("staging not given to the server account")
		}
		return nil, nil
	}
	must(t, h.e.Main())
	req := cp.requests[0]
	if req["mode"] != "restore" || !strings.HasPrefix(req["oneTimeRecipient"].(string), "age1") {
		t.Fatalf("request %v", req)
	}
	proof := req["relayProof"].(map[string]any)
	pubB64 := req["relayPublicKey"].(string)
	spki, _ := base64.StdEncoding.DecodeString(pubB64)
	pk, _ := x509.ParsePKIXPublicKey(spki)
	sig, _ := base64.StdEncoding.DecodeString(proof["sig"].(string))
	if proof["kind"] != "rotate" || proof["relayTeamId"] != "team_123" || !ed25519.Verify(pk.(ed25519.PublicKey), []byte(keyRotationString("team_123", pubB64)), sig) {
		t.Fatalf("rotate proof %v", proof)
	}
	if sawStaging == "" || exists(sawStaging) {
		t.Fatal("restore-artifacts not called or staging left behind")
	}
	key := filepath.Join(h.e.P.Base, "secrets", "credentials.key")
	if h.read("secrets/credentials.key") != base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))+"\n" || modeOf(t, key) != 0o600 || h.chowned[key] != [2]int{990, 990} {
		t.Fatal("credentials.key not written right")
	}
	if exists(filepath.Join(h.e.P.Base, "data", "setup-token")) {
		t.Fatal("restore must not write a setup token")
	}
	if h.status().State != "ok" || len(h.run.named("systemctl")) != 1 {
		t.Fatal("restore did not finish with started units")
	}
}

func TestRestoreShaMismatch(t *testing.T) {
	h := newHarness(t)
	cp := newFakeCP(t)
	cp.addObject("db.sqlite.age", []byte("SQLITE-DB"))
	cp.addObject("team.tar.zst.age", []byte("TEAM"))
	cp.badSha = true
	h.useCP(cp)
	h.writeEnroll("restore", cp.srv.URL)
	h.mounted = true
	h.run.adminFn = func(args []string) ([]byte, error) {
		t.Fatal("admin.js must not run after a bad download")
		return nil, nil
	}
	if err := h.e.Main(); err == nil {
		t.Fatal("expected failure")
	}
	st := h.status()
	if st.State != "failed" || st.Error.Code != "restore_failed" || !strings.Contains(st.Error.Message, "sha256") {
		t.Fatalf("status %+v", st.Error)
	}
	if exists(filepath.Join(h.e.P.Base, "data", ".restore-staging")) || len(h.run.named("systemctl")) != 0 {
		t.Fatal("staging left or services started")
	}
}

func TestVerifyMode(t *testing.T) {
	h := newHarness(t)
	cp := newFakeCP(t)
	cp.addObject("db.sqlite.age", []byte("SQLITE-DB"))
	cp.addObject("team.tar.zst.age", []byte("TEAM"))
	h.useCP(cp)
	h.writeEnroll("verify", cp.srv.URL)
	h.mounted = true
	h.run.adminFn = func(args []string) ([]byte, error) {
		i := indexOf(args, "restore-verify")
		if i < 0 || args[i+3] != "--expect" || !strings.Contains(args[i+4], `"schemaVersion":105`) {
			t.Fatalf("verify args %v", args)
		}
		return []byte(`{"ok":true,"files":2,"bytes":13,"schemaVersion":105}`), nil
	}
	must(t, h.e.Main())
	req := cp.requests[0]
	if req["relayPublicKey"] != nil || req["relayProof"] != nil || req["oneTimeRecipient"] == nil {
		t.Fatalf("verify request %v", req)
	}
	st := h.status()
	if st.State != "ok" || st.Verify == nil || !st.Verify.OK || st.Verify.Files != 2 || st.Verify.Bytes != 13 || st.Verify.SchemaVersion == nil || *st.Verify.SchemaVersion != 105 {
		t.Fatalf("verify status %+v", st.Verify)
	}
	if len(h.run.named("systemctl")) != 0 || exists(h.e.P.CloudInitDisabled) || len(h.run.named("mycel-ctl")) != 0 {
		t.Fatal("verify must not start or configure anything")
	}
	if exists(filepath.Join(h.e.P.Base, "data", "relay", "team-key.pem")) || exists(filepath.Join(h.e.P.Base, "data", ".restore-verify")) {
		t.Fatal("verify left a relay key or the scratch data")
	}
}

func TestReattachNoNetworkNeverFormats(t *testing.T) {
	h := newHarness(t)
	cp := newFakeCP(t)
	h.useCP(cp)
	h.writeEnroll("reattach", cp.srv.URL)
	// the data disk exists (label axdata) and holds an install; BASE is not mounted yet (new OS disk)
	must(t, os.MkdirAll(filepath.Join(h.e.P.Base, "root"), 0o755))
	must(t, os.WriteFile(filepath.Join(h.e.P.Base, "root", "VERSION"), []byte("0.3.4\n"), 0o644))
	h.run.labelDev = "/dev/sdb"
	must(t, h.e.Main())
	if len(cp.requests) != 0 {
		t.Fatal("reattach called the control plane")
	}
	if len(h.run.named("mkfs.ext4")) != 0 || len(h.run.named("cp")) != 0 {
		t.Fatal("reattach formatted or reseeded")
	}
	m := h.run.named("mount")
	if len(m) != 1 || m[0].args[len(m[0].args)-2] != "/dev/sdb" {
		t.Fatalf("mount %+v", m)
	}
	st := h.status()
	if st.State != "ok" || st.Mode != "reattach" || *st.KitVersion != "0.3.4" || len(h.run.named("systemctl")) != 1 {
		t.Fatalf("status %+v", st)
	}
	def, _ := os.ReadFile(h.e.P.DefaultFile)
	if !strings.Contains(string(def), "MYCEL_TEAM_TZ=Asia/Seoul") {
		t.Fatal("defaults not rewritten")
	}
}

func TestReattachWithoutDataDiskFails(t *testing.T) {
	h := newHarness(t)
	h.writeEnroll("reattach", "https://cp.invalid")
	h.run.lsblk = `{"blockdevices":[{"name":"sdb","path":"/dev/sdb","type":"disk","fstype":null,"mountpoints":[null],"size":21474836480}]}`
	if err := h.e.Main(); err == nil {
		t.Fatal("expected failure")
	}
	if h.status().Error.Code != "data_disk_missing" || len(h.run.named("mkfs.ext4")) != 0 || len(h.run.named("lsblk")) != 0 {
		t.Fatalf("reattach must fail without formatting: %+v", h.status().Error)
	}
}

func TestStandalone(t *testing.T) {
	h := newHarness(t)
	h.e.O.Standalone = true
	h.run.lsblk = `{"blockdevices":[{"name":"vda","path":"/dev/vda","type":"disk","fstype":null,"mountpoints":[null],"size":1,"children":[{"name":"vda1","type":"part","fstype":"ext4","mountpoints":["/"]}]}]}`
	must(t, h.e.Main())
	tok := strings.TrimSpace(h.read("data/setup-token"))
	if len(tok) != 32 || modeOf(t, filepath.Join(h.e.P.Base, "data", "setup-token")) != 0o600 {
		t.Fatalf("token %q", tok)
	}
	sj := h.read("config/server.json")
	if !strings.Contains(sj, `"deployment": "self"`) || !strings.Contains(sj, `"anthropic-oauth"`) || !strings.Contains(sj, `"chatgpt"`) {
		t.Fatalf("server.json %s", sj)
	}
	if !strings.Contains(h.out.String(), "http://127.0.0.1:47820/setup?token="+tok) {
		t.Fatalf("no setup instructions:\n%s", h.out.String())
	}
	if len(h.run.named("mkfs.ext4")) != 0 || exists(h.e.P.StatusFile) || len(h.run.named("systemctl")) != 1 {
		t.Fatal("standalone formatted a disk, wrote the cloud status file or did not start")
	}
	// a second run keeps the token and an owner's credentialKinds choice
	sjPath := filepath.Join(h.e.P.Base, "config", "server.json")
	must(t, os.WriteFile(sjPath, []byte(strings.Replace(sj, `"anthropic-oauth",`, ``, 1)), 0o600))
	h.out.Reset()
	must(t, h.e.Main())
	if strings.TrimSpace(h.read("data/setup-token")) != tok || strings.Contains(h.read("config/server.json"), `"anthropic-oauth"`) {
		t.Fatal("second standalone run changed the token or the kinds")
	}
}

func TestDataDiskDecisions(t *testing.T) {
	blank := `{"blockdevices":[
	 {"name":"sda","path":"/dev/sda","type":"disk","fstype":null,"mountpoints":[null],"size":12884901888,"children":[{"name":"sda1","path":"/dev/sda1","type":"part","fstype":"ext4","mountpoints":["/"]}]},
	 {"name":"sdb","path":"/dev/sdb","type":"disk","fstype":null,"mountpoints":[null],"size":21474836480},
	 {"name":"zram0","path":"/dev/zram0","type":"disk","fstype":null,"mountpoints":[null],"size":1073741824},
	 {"name":"sr0","path":"/dev/sr0","type":"rom","fstype":"iso9660","mountpoints":[null],"size":4194304}]}`
	two := `{"blockdevices":[{"name":"sdb","path":"/dev/sdb","type":"disk","fstype":null,"mountpoints":[null],"size":1},{"name":"sdc","path":"/dev/sdc","type":"disk","fstype":null,"mountpoints":[null],"size":1}]}`
	cases := []struct {
		name              string
		mounted           bool
		label             string
		lsblk             string
		probe             map[string]string
		device            string
		standalone        bool
		wantErr           string
		wantMkfs, wantMnt string
	}{
		{name: "mountpoint", mounted: true},
		{name: "label found", label: "/dev/sdb", wantMnt: "/dev/sdb"},
		{name: "blank auto", lsblk: blank, wantMkfs: "/dev/sdb", wantMnt: "/dev/sdb"},
		{name: "signature present", lsblk: blank, probe: map[string]string{"/dev/sdb": `/dev/sdb: PTUUID="x" PTTYPE="gpt"`}, wantErr: "data_disk_not_blank"},
		{name: "explicit device with fs", device: "/dev/vdc", probe: map[string]string{"/dev/vdc": `/dev/vdc: TYPE="xfs"`}, wantErr: "data_disk_not_blank"},
		{name: "explicit blank device", device: "/dev/vdc", wantMkfs: "/dev/vdc", wantMnt: "/dev/vdc"},
		{name: "ambiguous", lsblk: two, wantErr: "data_disk_ambiguous"},
		{name: "none found cloud", lsblk: `{"blockdevices":[]}`, wantErr: "data_disk_missing"},
		{name: "none found standalone", lsblk: `{"blockdevices":[]}`, standalone: true},
		{name: "none requested", device: "none"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			h.mounted = c.mounted
			h.run.labelDev = c.label
			h.run.lsblk = c.lsblk
			if c.probe != nil {
				h.run.probe = c.probe
			}
			if c.device != "" {
				h.e.O.DataDevice = c.device
			}
			err := h.e.dataDisk(false, c.standalone)
			if c.wantErr != "" {
				f, ok := err.(*failure)
				if !ok || f.Code != c.wantErr {
					t.Fatalf("err %v, want %s", err, c.wantErr)
				}
				if len(h.run.named("mkfs.ext4")) != 0 {
					t.Fatal("formatted on an error path")
				}
				return
			}
			must(t, err)
			mk := h.run.named("mkfs.ext4")
			if c.wantMkfs == "" && len(mk) != 0 || c.wantMkfs != "" && (len(mk) != 1 || mk[0].args[len(mk[0].args)-1] != c.wantMkfs || mk[0].args[2] != "axdata") {
				t.Fatalf("mkfs %+v", mk)
			}
			mn := h.run.named("mount")
			if c.wantMnt == "" && len(mn) != 0 || c.wantMnt != "" && (len(mn) != 1 || mn[0].args[len(mn[0].args)-2] != c.wantMnt || mn[0].args[len(mn[0].args)-1] != h.e.P.Base) {
				t.Fatalf("mount %+v", mn)
			}
		})
	}
}

func TestSeedNotRepeated(t *testing.T) {
	h := newHarness(t)
	must(t, os.MkdirAll(filepath.Join(h.e.P.Base, "root"), 0o755))
	must(t, os.WriteFile(filepath.Join(h.e.P.Base, "root", "VERSION"), []byte("0.3.9\n"), 0o644))
	must(t, h.e.seed())
	if len(h.run.named("cp")) != 0 || h.e.kitVersion != "0.3.9" {
		t.Fatal("an existing install was reseeded")
	}
	h2 := newHarness(t)
	must(t, os.RemoveAll(h2.e.P.Seed))
	if err := h2.e.seed(); err == nil || err.(*failure).Code != "kit_incomplete" {
		t.Fatalf("missing seed: %v", err)
	}
}

func TestMountinfoUnescape(t *testing.T) {
	if got := unescapeMountinfo(`/var/lib/my\040dir`); got != "/var/lib/my dir" {
		t.Fatal(got)
	}
}

// finalName maps atomicWrite's temp file (.<name>.<rand>.tmp, chowned before the rename) to the final path.
func finalName(p string) string {
	b := filepath.Base(p)
	if strings.HasPrefix(b, ".") && strings.HasSuffix(b, ".tmp") {
		s := strings.TrimSuffix(b[1:], ".tmp")
		if i := strings.LastIndex(s, "."); i > 0 {
			return filepath.Join(filepath.Dir(p), s[:i])
		}
	}
	return p
}

func indexOf(s []string, v string) int {
	for i, x := range s {
		if x == v {
			return i
		}
	}
	return -1
}

// The enroll request never carries an empty appVersion (control plane C-20): without app/current (the dev tenant
// image) it is the kit's version; with the link, the app's.
func TestAppVersionFallsBackToKit(t *testing.T) {
	base := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(base, "root"), 0o755))
	must(t, os.WriteFile(filepath.Join(base, "root", "VERSION"), []byte("0.3.4\n"), 0o644))
	e := &Enroller{P: Paths{Base: base}}
	if v := e.appVersion(); v != "0.3.4" {
		t.Fatalf("no app link: appVersion %q, want the kit's 0.3.4", v)
	}
	must(t, os.MkdirAll(filepath.Join(base, "app", "versions", "0.3.5"), 0o755))
	must(t, os.Symlink("versions/0.3.5", filepath.Join(base, "app", "current")))
	if v := e.appVersion(); v != "0.3.5" {
		t.Fatalf("app link: appVersion %q, want 0.3.5", v)
	}
}

// The escrow copy of the AI connections' key: version 1 is the bare line (raw or base64), a later version names its
// file so the restored rows find it; anything else is refused.
func TestCredentialsKeyFile(t *testing.T) {
	k := bytes.Repeat([]byte{7}, 32)
	b64 := base64.StdEncoding.EncodeToString(k)
	for _, c := range []struct{ in, name string }{{b64 + "\n", "credentials.key"}, {string(k), "credentials.key"}, {"credentials.key.3 " + b64 + "\n", "credentials.key.3"}} {
		name, line, err := credentialsKeyFile([]byte(c.in))
		if err != nil || name != c.name || line != b64 {
			t.Fatalf("%q: %q %q %v", c.in, name, line, err)
		}
	}
	for _, bad := range []string{"../../etc/shadow " + b64, "credentials.key.3 short", "x y z"} {
		if _, _, err := credentialsKeyFile([]byte(bad)); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}
