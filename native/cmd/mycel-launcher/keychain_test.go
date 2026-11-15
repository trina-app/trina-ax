package main

import (
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// memStore stands in for the login keychain (the real one is never opened by these tests)
type memStore struct {
	items  map[string]string
	locked bool
	adds   int
}

func (m *memStore) find(s string) (string, int) {
	if m.locked {
		return "", kcLocked
	}
	if v, ok := m.items[s]; ok {
		return v, 0
	}
	return "", kcNotFound
}
func (m *memStore) add(s, v string) int {
	if m.locked {
		return kcLocked
	}
	m.items[s] = v
	m.adds++
	return 0
}
func (m *memStore) info() int {
	if m.locked {
		return kcLocked
	}
	return 0
}

const fakeLogin = `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-FAKE","refreshToken":"sk-ant-ort01-FAKE","expiresAt":1999999999000,"scopes":["user:inference"]},"mcpOAuth":{"slack|x":{"accessToken":"xoxp-OTHER-SECRET"}}}`

func newBroker(t *testing.T, items map[string]string) (*kcBroker, *memStore) {
	t.Helper()
	st := &memStore{items: items}
	return &kcBroker{store: st, account: "office", credFile: filepath.Join(t.TempDir(), ".credentials.json")}, st
}

func find(b *kcBroker, svc string) kcResponse {
	return b.handle(kcRequest{Args: []string{"find-generic-password", "-a", "office", "-w", "-s", svc}})
}

func TestKeychainFindAnswersOnlyTheClaudeLogin(t *testing.T) {
	b, _ := newBroker(t, map[string]string{kcLoginService: fakeLogin, kcKeyService: "sk-ant-api03-KEY", "qa-canary": "CANARY-KC", "gh:github.com": "gho_TOKEN"})
	r := find(b, kcLoginService)
	if r.Code != 0 || !strings.Contains(r.Stdout, "sk-ant-oat01-FAKE") {
		t.Fatalf("login: %+v", r)
	}
	// the rest of the item (MCP servers' sign-ins) never reaches a turn
	if strings.Contains(r.Stdout, "xoxp-OTHER-SECRET") || strings.Contains(r.Stdout, "mcpOAuth") {
		t.Fatalf("login answer carries the rest of the item: %s", r.Stdout)
	}
	if r := find(b, kcKeyService); r.Code != 0 || r.Stdout != "sk-ant-api03-KEY\n" {
		t.Fatalf("API key login: %+v", r)
	}
	for _, args := range [][]string{
		{"find-generic-password", "-a", "office", "-w", "-s", "qa-canary"},                              // another item
		{"find-generic-password", "-a", "office", "-w", "-s", "gh:github.com"},                          // another tool's token
		{"find-generic-password", "-s", "qa-canary", "-w"},                                              // no account
		{"find-generic-password", "-a", "someone", "-w", "-s", kcLoginService},                          // another account
		{"find-generic-password", "-a", "office", "-g", "-s", kcLoginService},                           // -g prints attributes
		{"find-generic-password", "-a", "office", "-s", kcLoginService},                                 // no -w: attributes
		{"find-generic-password", "-a", "office", "-w", "-s", kcLoginService, "/tmp/other.keychain-db"}, // another keychain
		{"find-generic-password", "-a", "office", "-a", "office", "-w", "-s", kcLoginService},           // twice
		{"find-internet-password", "-s", "github.com", "-w"},
		{"dump-keychain", "-d"},
		{"export", "-k", "login.keychain"},
		{"delete-generic-password", "-a", "office", "-s", kcLoginService},
		{"unlock-keychain", "-p", "x"},
		{"set-generic-password-partition-list", "-S", "apple-tool:"},
		{"show-keychain-info", "/Library/Keychains/System.keychain"},
		{"-i", "extra"},
		{},
	} {
		r := b.handle(kcRequest{Args: args})
		if r.Code == 0 || strings.Contains(r.Stdout, "CANARY") || strings.Contains(r.Stdout, "gho_") {
			t.Errorf("%v: %+v", args, r)
		}
	}
	if r := b.handle(kcRequest{Args: []string{"show-keychain-info"}}); r.Code != 0 {
		t.Fatalf("show-keychain-info: %+v", r)
	}
}

func TestKeychainInteractiveLines(t *testing.T) {
	b, st := newBroker(t, map[string]string{kcLoginService: fakeLogin, "qa-canary": "CANARY-KC"})
	newLogin := `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-NEW","refreshToken":"sk-ant-ort01-NEW","expiresAt":2000000000000},"mcpOAuth":{"evil":{"accessToken":"planted"}}}`
	// what Claude Code 2.1.325 writes on `security -i`
	line := `add-generic-password -U -a "office" -s "Claude Code-credentials" -X "` + hex.EncodeToString([]byte(newLogin)) + `"` + "\n"
	if r := b.handle(kcRequest{Args: []string{"-i"}, Stdin: line}); r.Code != 0 {
		t.Fatalf("save: %+v", r)
	}
	var saved map[string]json.RawMessage
	if err := json.Unmarshal([]byte(st.items[kcLoginService]), &saved); err != nil {
		t.Fatal(err)
	}
	// only claudeAiOauth is taken; the item's other parts stay as they were
	if !strings.Contains(string(saved["claudeAiOauth"]), "sk-ant-oat01-NEW") || !strings.Contains(string(saved["mcpOAuth"]), "xoxp-OTHER-SECRET") || strings.Contains(st.items[kcLoginService], "planted") {
		t.Fatalf("merged item: %s", st.items[kcLoginService])
	}
	if r := find(b, kcLoginService); !strings.Contains(r.Stdout, "sk-ant-oat01-NEW") {
		t.Fatalf("read after save: %+v", r)
	}
	// a find of another item hidden behind a good line stops the batch
	r := b.handle(kcRequest{Args: []string{"-i"}, Stdin: "show-keychain-info\nfind-generic-password -a office -w -s qa-canary\n"})
	if r.Code == 0 || strings.Contains(r.Stdout, "CANARY") {
		t.Fatalf("batch: %+v", r)
	}
	for _, bad := range []string{
		`add-generic-password -U -a "office" -s "qa-canary" -w "x"`,                                  // another item
		`add-generic-password -a "office" -s "Claude Code-credentials" -w "{}"`,                      // not an update
		`add-generic-password -U -a "office" -s "Claude Code-credentials" -w "not json"`,             // not a login
		`add-generic-password -U -a "office" -s "Claude Code-credentials" -w '{"claudeAiOauth":{}}'`, // no token
		`add-generic-password -U -a "office" -s "Claude Code-credentials" -X "zz"`,                   // bad hex
		`add-generic-password -U -a "office" -s "Claude Code-credentials" -T /bin/sh -w "{}"`,        // trusted app
		`add-generic-password -U -a "office" -s "Claude Code-credentials -w "x"`,                     // broken quote
	} {
		if r := b.handle(kcRequest{Args: []string{"-i"}, Stdin: bad + "\n"}); r.Code == 0 {
			t.Errorf("%s: %+v", bad, r)
		}
	}
	if st.adds != 1 {
		t.Fatalf("adds = %d", st.adds)
	}
}

func TestKeychainSplit(t *testing.T) {
	got, err := kcSplit(`add-generic-password -U -a "o ffice" -s 'Claude Code' -X "a\"b"`)
	if err != nil || strings.Join(got, "|") != `add-generic-password|-U|-a|o ffice|-s|Claude Code|-X|a"b` {
		t.Fatalf("%q %v", got, err)
	}
}

func TestKeychainCredentialsFile(t *testing.T) {
	// no keychain item: the login of ~/.claude/.credentials.json is answered, and a refreshed one goes back there
	b, st := newBroker(t, map[string]string{})
	if err := os.WriteFile(b.credFile, []byte(fakeLogin), 0o600); err != nil {
		t.Fatal(err)
	}
	if r := find(b, kcLoginService); r.Code != 0 || !strings.Contains(r.Stdout, "sk-ant-oat01-FAKE") || strings.Contains(r.Stdout, "xoxp") {
		t.Fatalf("file login: %+v", r)
	}
	save := `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-NEW"}}`
	if r := b.handle(kcRequest{Args: []string{"add-generic-password", "-U", "-a", "office", "-s", kcLoginService, "-w", save}}); r.Code != 0 {
		t.Fatalf("save: %+v", r)
	}
	if st.adds != 0 {
		t.Fatal("saved into the keychain instead of the file it came from")
	}
	raw, _ := os.ReadFile(b.credFile)
	if !strings.Contains(string(raw), "sk-ant-oat01-NEW") || !strings.Contains(string(raw), "xoxp-OTHER-SECRET") {
		t.Fatalf("file: %s", raw)
	}
	if fi, _ := os.Stat(b.credFile); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
	// a locked keychain with the login in the file: the file
	st.locked = true
	if r := find(b, kcLoginService); r.Code != 0 {
		t.Fatalf("locked + file: %+v", r)
	}
	// a locked keychain and no file: 36, and nothing is created
	os.Remove(b.credFile)
	if r := find(b, kcLoginService); r.Code != kcLocked {
		t.Fatalf("locked: %+v", r)
	}
	if r := b.handle(kcRequest{Args: []string{"add-generic-password", "-U", "-a", "office", "-s", kcLoginService, "-w", save}}); r.Code != kcLocked {
		t.Fatalf("save while locked: %+v", r)
	}
	// nothing anywhere: not found, and a first save creates the item
	st.locked = false
	if r := find(b, kcLoginService); r.Code != kcNotFound {
		t.Fatalf("none: %+v", r)
	}
	if r := b.handle(kcRequest{Args: []string{"add-generic-password", "-U", "-a", "office", "-s", kcLoginService, "-w", save}}); r.Code != 0 || st.adds != 1 {
		t.Fatalf("first save: %+v", r)
	}
	// a link at the file's place is never written through
	b2, _ := newBroker(t, map[string]string{})
	target := filepath.Join(t.TempDir(), "target")
	os.WriteFile(target, []byte(fakeLogin), 0o600)
	os.Symlink(target, b2.credFile)
	if r := b2.handle(kcRequest{Args: []string{"add-generic-password", "-U", "-a", "office", "-s", kcLoginService, "-w", save}}); r.Code == 0 {
		t.Fatalf("wrote through a link: %+v", r)
	}
}

func TestKeychainSocketOnlyForRunningTurns(t *testing.T) {
	// the macOS socket path limit (104 bytes) is shorter than t.TempDir() on some machines
	dir, err := os.MkdirTemp("/tmp", "kc")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	store := filepath.Join(dir, "store.json")
	os.WriteFile(store, []byte(`{"Claude Code-credentials":`+jsonString(fakeLogin)+`}`), 0o600)
	saveHome := accountHome
	accountHome = dir
	defer func() { accountHome = saveHome }()
	if err := startKeychainBroker(filepath.Join(dir, "kc"), "/nonexistent/bridge", fileStore{path: store}); err != nil {
		t.Fatal(err)
	}
	if l, err := os.Readlink(filepath.Join(dir, "kc", "security")); err != nil || l != "/nonexistent/bridge" {
		t.Fatalf("link %q %v", l, err)
	}
	ask := func() kcResponse {
		c, err := net.DialTimeout("unix", filepath.Join(dir, "kc", "sock"), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		j, _ := json.Marshal(kcRequest{Args: []string{"find-generic-password", "-a", kcAccount(), "-w", "-s", kcLoginService}})
		c.Write(append(j, '\n'))
		var r kcResponse
		if err := json.NewDecoder(c).Decode(&r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	if r := ask(); r.Code == 0 || strings.Contains(r.Stdout, "FAKE") {
		t.Fatalf("a process outside every turn got an answer: %+v", r)
	}
	sid := mySid(t)
	kcTurns.add(sid)
	defer kcTurns.del(sid)
	if r := ask(); r.Code != 0 || !strings.Contains(r.Stdout, "sk-ant-oat01-FAKE") {
		t.Fatalf("turn: %+v", r)
	}
}

func jsonString(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestKeychainEnv(t *testing.T) {
	saved := kcDir
	kcDir = "/run/kc"
	defer func() { kcDir = saved }()
	got := strings.Join(kcEnv([]string{"PATH=/usr/bin:/bin", "HOME=/h", "MYCEL_KEYCHAIN_SOCK=/elsewhere"}), " ")
	if got != "HOME=/h PATH=/run/kc:/usr/bin:/bin MYCEL_KEYCHAIN_SOCK=/run/kc/sock" {
		t.Fatal(got)
	}
}

func mySid(t *testing.T) int {
	sid, err := unix.Getsid(0)
	if err != nil {
		t.Fatal(err)
	}
	return sid
}
