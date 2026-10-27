package main

// Links the engine plants in its chat folder around the Codex home (security audit of the managed Codex path, D27):
// AT <chat>/.codex / <chat>/.home, and INSIDE <chat>/.codex (auth.json, config.toml). The per-turn write and the
// wipe must neither write through, read through nor delete the link targets, and the turn still gets a fresh home.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// a placeholder login codexManagedBegin accepts (apikey mode: this turn's proxy token)
var managedAuth = `{"auth_mode":"apikey","OPENAI_API_KEY":"mpx_` + strings.Repeat("A", 43) + `"}`

// decoys: a folder outside the chat (another chat's) holding files the engine would like overwritten / read / deleted
func plantDecoys(t *testing.T, other string) (dir, auth, cfg string) {
	t.Helper()
	dir = filepath.Join(other, "decoy")
	must(t, os.MkdirAll(dir, 0o700))
	auth, cfg = filepath.Join(dir, "auth.json"), filepath.Join(dir, "config.toml")
	must(t, os.WriteFile(auth, []byte("DECOY-AUTH"), 0o600))
	must(t, os.WriteFile(cfg, []byte("DECOY-CONFIG"), 0o600))
	return
}

func checkDecoys(t *testing.T, dir, auth, cfg string) {
	t.Helper()
	if b, err := os.ReadFile(auth); err != nil || string(b) != "DECOY-AUTH" {
		t.Fatalf("decoy auth.json written through or removed: %q %v", b, err)
	}
	if b, err := os.ReadFile(cfg); err != nil || string(b) != "DECOY-CONFIG" {
		t.Fatalf("decoy config.toml written through or removed: %q %v", b, err)
	}
	if names, _ := os.ReadDir(dir); len(names) != 2 {
		t.Fatalf("decoy folder changed: %v", names)
	}
}

// the chat's own .codex must be a real folder (not a link) holding a plain auth.json with want
func checkFreshHome(t *testing.T, chat, want string) {
	t.Helper()
	for _, n := range []string{".codex", ".home"} {
		st, err := os.Lstat(filepath.Join(chat, n))
		if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			t.Fatalf("%s is not a fresh real folder: %v %v", n, st, err)
		}
	}
	st, err := os.Lstat(filepath.Join(chat, ".codex", "auth.json"))
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0o600 {
		t.Fatalf(".codex/auth.json is not a plain 0600 file: %v %v", st, err)
	}
	if b, _ := os.ReadFile(filepath.Join(chat, ".codex", "auth.json")); string(b) != want {
		t.Fatalf(".codex/auth.json = %q", b)
	}
	if names, _ := os.ReadDir(filepath.Join(chat, ".codex")); len(names) != 1 {
		t.Fatalf(".codex not fresh: %v", names)
	}
	if names, _ := os.ReadDir(filepath.Join(chat, ".home")); len(names) != 0 {
		t.Fatalf(".home not empty: %v", names)
	}
}

func checkGone(t *testing.T, chat string) {
	t.Helper()
	for _, n := range []string{".codex", ".home"} {
		if exists(filepath.Join(chat, n)) {
			t.Fatalf("%s left behind", n)
		}
	}
}

func TestManagedCodexHomeLinkAtCodexFolder(t *testing.T) {
	_, chat, other, _ := setupAgent(t)
	dir, auth, cfg := plantDecoys(t, other)
	must(t, os.Symlink(dir, filepath.Join(chat, ".codex")))
	must(t, os.Symlink(dir, filepath.Join(chat, ".home")))
	must(t, codexManagedBegin(chat, managedAuth))
	checkDecoys(t, dir, auth, cfg)
	checkFreshHome(t, chat, managedAuth)
	// during the turn the engine swaps .codex for a link again; the wipe removes the link only
	must(t, os.RemoveAll(filepath.Join(chat, ".codex")))
	must(t, os.Symlink(dir, filepath.Join(chat, ".codex")))
	codexManagedEnd(chat)
	checkDecoys(t, dir, auth, cfg)
	checkGone(t, chat)
}

func TestManagedCodexHomeLinksInsideCodexFolder(t *testing.T) {
	_, chat, other, _ := setupAgent(t)
	dir, auth, cfg := plantDecoys(t, other)
	// a left-over .codex whose files are links to the decoys (and a linked sub-folder)
	must(t, os.MkdirAll(filepath.Join(chat, ".codex"), 0o700))
	must(t, os.Symlink(auth, filepath.Join(chat, ".codex", "auth.json")))
	must(t, os.Symlink(cfg, filepath.Join(chat, ".codex", "config.toml")))
	must(t, os.Symlink(dir, filepath.Join(chat, ".codex", "sessions")))
	must(t, codexManagedBegin(chat, managedAuth))
	checkDecoys(t, dir, auth, cfg)
	checkFreshHome(t, chat, managedAuth)
	// the engine plants links inside .codex during the turn; the wipe unlinks them and leaves their targets
	must(t, os.Remove(filepath.Join(chat, ".codex", "auth.json")))
	must(t, os.Symlink(auth, filepath.Join(chat, ".codex", "auth.json")))
	must(t, os.Symlink(cfg, filepath.Join(chat, ".codex", "config.toml")))
	must(t, os.Symlink(dir, filepath.Join(chat, ".codex", "log")))
	codexManagedEnd(chat)
	checkDecoys(t, dir, auth, cfg)
	checkGone(t, chat)
}

func TestManagedCodexRefusesRealLoginEvenWithLinks(t *testing.T) {
	_, chat, other, _ := setupAgent(t)
	dir, auth, cfg := plantDecoys(t, other)
	must(t, os.Symlink(dir, filepath.Join(chat, ".codex")))
	if err := codexManagedBegin(chat, `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-real-key"}`); err == nil {
		t.Fatal("a real-looking key was accepted")
	}
	checkDecoys(t, dir, auth, cfg)
}

func TestAgentOwnCodexBeginLinksAtAndInsideCodexFolder(t *testing.T) {
	agent, chat, other, secret := setupAgent(t)
	old := *codexAuthDir
	*codexAuthDir = filepath.Join(agent, "codex-auth")
	defer func() { *codexAuthDir = old }()
	dir, auth, cfg := plantDecoys(t, other)
	real, err := os.ReadFile(secret)
	must(t, err)
	// at: .codex -> decoy folder (the real login copy must not land there)
	must(t, os.Symlink(dir, filepath.Join(chat, ".codex")))
	ct, err := codexBegin(chat, make(chan struct{}))
	must(t, err)
	checkDecoys(t, dir, auth, cfg)
	checkFreshHome(t, chat, string(real))
	// inside: auth.json and config.toml become links to the decoys during the turn; end reads nothing through them,
	// writes nothing back, removes the links only
	must(t, os.Remove(filepath.Join(chat, ".codex", "auth.json")))
	must(t, os.Symlink(auth, filepath.Join(chat, ".codex", "auth.json")))
	must(t, os.Symlink(cfg, filepath.Join(chat, ".codex", "config.toml")))
	notes := ct.end()
	checkDecoys(t, dir, auth, cfg)
	checkGone(t, chat)
	if b, _ := os.ReadFile(secret); string(b) != string(real) {
		t.Fatalf("the login was changed through a link: %s (notes %v)", b, notes)
	}
	if len(notes) == 0 || !strings.Contains(notes[0], "codex_auth_writeback_refused") {
		t.Fatalf("a linked auth.json was not reported: %v", notes)
	}
}

func TestLeftOverCodexFolderAndTurnFolderLinks(t *testing.T) {
	_, chat, other, _ := setupAgent(t)
	dir, auth, cfg := plantDecoys(t, other)
	must(t, os.Symlink(dir, filepath.Join(chat, ".codex")))
	d, err := openRoot(chat)
	must(t, err)
	defer d.close()
	// what a non-Codex turn does at its start (main.go) and what the .turn / .tmp setup does
	must(t, d.removeAll(".codex"))
	must(t, os.Symlink(dir, filepath.Join(chat, ".turn")))
	must(t, d.removeAll(".turn"))
	must(t, d.mkdirAll(".turn", 0o700))
	must(t, d.writeNew(".turn/token", []byte("mpx_x"), 0o600))
	must(t, os.Symlink(dir, filepath.Join(chat, ".tmp")))
	must(t, d.mkdirAll(".tmp", 0o700))
	checkDecoys(t, dir, auth, cfg)
	if exists(filepath.Join(chat, ".codex")) {
		t.Fatal("left-over .codex link not removed")
	}
	for _, n := range []string{".turn", ".tmp"} {
		if st, err := os.Lstat(filepath.Join(chat, n)); err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			t.Fatalf("%s is not a real folder after setup", n)
		}
	}
	// the engine swaps .turn for a link mid-turn: removing system.md must not reach through it
	sys := filepath.Join(dir, "system.md")
	must(t, os.WriteFile(sys, []byte("OTHER"), 0o600))
	must(t, os.RemoveAll(filepath.Join(chat, ".turn")))
	must(t, os.Symlink(dir, filepath.Join(chat, ".turn")))
	_ = d.remove(filepath.Join(".turn", "system.md"))
	if b, _ := os.ReadFile(sys); string(b) != "OTHER" {
		t.Fatal("system.md removed through a linked .turn")
	}
}
