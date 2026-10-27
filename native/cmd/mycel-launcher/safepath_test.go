package main

import (
	"os"
	"path/filepath"
	"testing"
)

// layout: <w>/agent/{chat1,chat2,codex-auth}, a secret outside
func setupAgent(t *testing.T) (agent, chat, other, secret string) {
	t.Helper()
	w, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	agent = filepath.Join(w, "agent")
	chat = filepath.Join(agent, "chat1")
	other = filepath.Join(agent, "chat2")
	for _, d := range []string{chat, other, filepath.Join(agent, "codex-auth"), filepath.Join(other, "projects", "p")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	secret = filepath.Join(agent, "codex-auth", "auth.json")
	must(t, os.WriteFile(secret, []byte(`{"tokens":{"account_id":"a","refresh_token":"CANARY-CODEXAUTH"}}`), 0o600))
	must(t, os.WriteFile(filepath.Join(other, "projects", "p", "s.jsonl"), []byte("CANARY-OTHER-CHAT"), 0o600))
	return
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

func TestCollectSessionDoesNotFollowLinkedTranscript(t *testing.T) {
	_, chat, _, secret := setupAgent(t)
	must(t, os.MkdirAll(filepath.Join(chat, ".claude", "projects", "x"), 0o700))
	must(t, os.Symlink(secret, filepath.Join(chat, ".claude", "projects", "x", "sid.jsonl")))
	b, _ := collectSession(chat, filepath.Join(chat, ".claude", "projects"), "sid.jsonl", true)
	if len(b) != 0 {
		t.Fatalf("collected through a link: %q", b)
	}
	if !exists(secret) {
		t.Fatal("the link target was removed")
	}
	if exists(filepath.Join(chat, ".claude", "projects")) {
		t.Fatal("removeDir did not remove the projects folder")
	}
}

func TestCollectSessionExactNameLink(t *testing.T) {
	_, chat, _, secret := setupAgent(t)
	must(t, os.MkdirAll(filepath.Join(chat, ".claude", "projects"), 0o700))
	must(t, os.Symlink(secret, filepath.Join(chat, ".claude", "projects", "sid.jsonl")))
	if b, _ := collectSession(chat, filepath.Join(chat, ".claude", "projects"), "sid.jsonl", true); len(b) != 0 {
		t.Fatalf("collected through a link: %q", b)
	}
	if !exists(secret) {
		t.Fatal("the link target was removed")
	}
}

func TestCollectSessionThroughLinkedSubfolder(t *testing.T) {
	_, chat, other, _ := setupAgent(t)
	must(t, os.MkdirAll(filepath.Join(chat, ".claude", "projects"), 0o700))
	// projects/x -> the other chat's project folder that holds s.jsonl
	must(t, os.Symlink(filepath.Join(other, "projects", "p"), filepath.Join(chat, ".claude", "projects", "x")))
	if b, _ := collectSession(chat, filepath.Join(chat, ".claude", "projects"), "s.jsonl", true); len(b) != 0 {
		t.Fatalf("collected another chat's transcript: %q", b)
	}
	if !exists(filepath.Join(other, "projects", "p", "s.jsonl")) {
		t.Fatal("the other chat's transcript was removed")
	}
}

func TestCollectSessionLinkedClaudeFolderKeepsOtherChat(t *testing.T) {
	_, chat, other, _ := setupAgent(t)
	// <chat>/.claude -> <other chat>: RemoveAll(<chat>/.claude/projects) used to delete <other>/projects
	must(t, os.Symlink(other, filepath.Join(chat, ".claude")))
	b, _ := collectSession(chat, filepath.Join(chat, ".claude", "projects"), "s.jsonl", true)
	if len(b) != 0 {
		t.Fatalf("collected through a linked .claude: %q", b)
	}
	if !exists(filepath.Join(other, "projects", "p", "s.jsonl")) {
		t.Fatal("another chat's projects folder was removed through the link")
	}
}

func TestCollectSessionPlainFileWorks(t *testing.T) {
	_, chat, _, _ := setupAgent(t)
	dir := filepath.Join(chat, ".claude", "projects", "slug")
	must(t, os.MkdirAll(dir, 0o700))
	must(t, os.WriteFile(filepath.Join(dir, "sid.jsonl"), []byte("transcript"), 0o600))
	b, err := collectSession(chat, filepath.Join(chat, ".claude", "projects"), "sid.jsonl", true)
	if err != nil || string(b) != "transcript" {
		t.Fatalf("got %q %v", b, err)
	}
	if exists(filepath.Join(chat, ".claude", "projects")) {
		t.Fatal("projects not removed")
	}
	if !exists(filepath.Join(chat, ".claude")) {
		t.Fatal(".claude removed (only projects should go)")
	}
}

func TestCollectSessionHardLinkRefused(t *testing.T) {
	_, chat, _, _ := setupAgent(t)
	dir := filepath.Join(chat, ".claude", "projects")
	must(t, os.MkdirAll(dir, 0o700))
	src := filepath.Join(chat, "own.txt")
	must(t, os.WriteFile(src, []byte("x"), 0o600))
	must(t, os.Link(src, filepath.Join(dir, "sid.jsonl")))
	if b, _ := collectSession(chat, dir, "sid.jsonl", false); len(b) != 0 {
		t.Fatalf("a file with two links was collected: %q", b)
	}
}

func TestRestoreSessionDoesNotWriteThroughLinks(t *testing.T) {
	_, chat, other, _ := setupAgent(t)
	// .claude -> other chat
	must(t, os.Symlink(other, filepath.Join(chat, ".claude")))
	must(t, restoreSession(chat, filepath.Join(chat, ".claude", "projects", "restored"), "sid.jsonl", []byte("mine")))
	if exists(filepath.Join(other, "projects", "restored")) {
		t.Fatal("restored into another chat through a linked .claude")
	}
	b, err := os.ReadFile(filepath.Join(chat, ".claude", "projects", "restored", "sid.jsonl"))
	if err != nil || string(b) != "mine" {
		t.Fatalf("own restore missing: %q %v", b, err)
	}
	st, _ := os.Lstat(filepath.Join(chat, ".claude"))
	if st == nil || !st.IsDir() {
		t.Fatal(".claude was not replaced by a real folder")
	}
	// the restored folder itself a link, and the file name a link
	_, chat2, other2, secret := setupAgent(t)
	must(t, os.MkdirAll(filepath.Join(chat2, ".claude", "projects"), 0o700))
	must(t, os.Symlink(filepath.Join(other2, "projects"), filepath.Join(chat2, ".claude", "projects", "restored")))
	must(t, restoreSession(chat2, filepath.Join(chat2, ".claude", "projects", "restored"), "s.jsonl", []byte("mine")))
	if b, _ := os.ReadFile(filepath.Join(other2, "projects", "s.jsonl")); len(b) != 0 {
		t.Fatal("wrote into another chat through a linked restored folder")
	}
	must(t, os.Symlink(secret, filepath.Join(chat2, ".claude", "projects", "restored", "t.jsonl")))
	must(t, restoreSession(chat2, filepath.Join(chat2, ".claude", "projects", "restored"), "t.jsonl", []byte("new")))
	if b, _ := os.ReadFile(secret); string(b) == "new" {
		t.Fatal("wrote through a link at the file name")
	}
}

func TestRestoreSessionOutsideRootsRefused(t *testing.T) {
	_, chat, other, _ := setupAgent(t)
	if err := restoreSession(chat, filepath.Join(other, "x"), "s.jsonl", []byte("x")); err == nil {
		t.Fatal("restore outside the chat folder accepted")
	}
	if err := restoreSession(chat, filepath.Join(chat, "x"), "../s.jsonl", []byte("x")); err == nil {
		t.Fatal("name with a slash accepted")
	}
}

func TestWriteNewAndRemoveAllDoNotFollow(t *testing.T) {
	_, chat, other, _ := setupAgent(t)
	must(t, os.Symlink(other, filepath.Join(chat, "cfg")))
	d, err := openRoot(chat)
	must(t, err)
	defer d.close()
	must(t, d.writeNew("cfg/projects/p/s.jsonl", []byte("overwritten"), 0o600))
	if b, _ := os.ReadFile(filepath.Join(other, "projects", "p", "s.jsonl")); string(b) != "CANARY-OTHER-CHAT" {
		t.Fatal("writeNew followed a link")
	}
	// removeAll of a tree with a link inside removes the link, not its target
	must(t, os.MkdirAll(filepath.Join(chat, "tree", "a"), 0o700))
	must(t, os.Symlink(other, filepath.Join(chat, "tree", "a", "l")))
	must(t, d.removeAll("tree"))
	if exists(filepath.Join(chat, "tree")) || !exists(filepath.Join(other, "projects", "p", "s.jsonl")) {
		t.Fatal("removeAll followed a link or left the tree")
	}
	// the root emptied in place
	must(t, os.WriteFile(filepath.Join(chat, "f"), []byte("x"), 0o600))
	must(t, d.removeAll("."))
	if names, _ := os.ReadDir(chat); len(names) != 0 || !exists(chat) {
		t.Fatalf("root not emptied in place: %v", names)
	}
	if _, err := splitRel("../x"); err == nil {
		t.Fatal(".. accepted")
	}
	if _, err := splitRel("/abs"); err == nil {
		t.Fatal("absolute accepted")
	}
}

func TestCodexEndDoesNotReadThroughLinkedFolder(t *testing.T) {
	agent, chat, other, secret := setupAgent(t)
	old := *codexAuthDir
	*codexAuthDir = filepath.Join(agent, "codex-auth")
	defer func() { *codexAuthDir = old }()
	ct, err := codexBegin(chat, make(chan struct{}))
	must(t, err)
	// the engine swaps .codex for a link to a folder whose auth.json has the same account and a new token
	must(t, os.MkdirAll(filepath.Join(other, "fake"), 0o700))
	must(t, os.WriteFile(filepath.Join(other, "fake", "auth.json"), []byte(`{"tokens":{"account_id":"a","refresh_token":"ATTACKER"}}`), 0o600))
	must(t, os.RemoveAll(filepath.Join(chat, ".codex")))
	must(t, os.Symlink(filepath.Join(other, "fake"), filepath.Join(chat, ".codex")))
	notes := ct.end()
	if b, _ := os.ReadFile(secret); string(b) != `{"tokens":{"account_id":"a","refresh_token":"CANARY-CODEXAUTH"}}` {
		t.Fatalf("login overwritten through a linked .codex: %s (notes %v)", b, notes)
	}
	if !exists(filepath.Join(other, "fake", "auth.json")) {
		t.Fatal("link target removed")
	}
	if exists(filepath.Join(chat, ".codex")) {
		t.Fatal(".codex link left behind")
	}
}
