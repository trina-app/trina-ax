package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestKeepLocalCodexHome(t *testing.T) {
	login, codex := *localLogin, *localCodex
	t.Cleanup(func() { *localLogin, *localCodex = login, codex })
	for _, tc := range []struct {
		name                       string
		login, codex, managed, own bool
		home, kind                 string
		keep, fail                 bool
	}{
		{"local", true, true, false, false, "chat", "dir", true, false},
		{"no local login", false, true, false, false, "chat", "dir", false, false},
		{"no local codex", true, false, false, false, "chat", "dir", false, false},
		{"managed", true, true, true, false, "chat", "dir", false, false},
		{"agent own", true, true, false, true, "chat", "dir", false, false},
		{"other chat path", true, true, false, false, "other", "dir", false, false},
		{"outside path", true, true, false, false, "outside", "dir", false, false},
		{"other engine", true, true, false, false, "", "dir", false, false},
		{"linked home", true, true, false, false, "chat", "link", false, true},
		{"file home", true, true, false, false, "chat", "file", false, true},
		{"missing home", true, true, false, false, "chat", "missing", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			*localLogin, *localCodex = tc.login, tc.codex
			base := t.TempDir()
			chat, other := filepath.Join(base, "chat"), filepath.Join(base, "other")
			must(t, os.Mkdir(chat, 0o700))
			must(t, os.Mkdir(other, 0o700))
			home := filepath.Join(chat, ".codex")
			switch tc.kind {
			case "dir":
				must(t, os.Mkdir(home, 0o700))
				must(t, os.Symlink(filepath.Join(base, "synthetic-login"), filepath.Join(home, "auth.json")))
			case "link":
				must(t, os.Symlink(other, home))
			case "file":
				must(t, os.WriteFile(home, []byte("fixture"), 0o600))
			}
			r, err := openRoot(chat)
			must(t, err)
			defer r.close()
			req := &request{Env: map[string]string{"CODEX_HOME": map[string]string{
				"chat": home, "other": filepath.Join(other, ".codex"), "outside": base,
			}[tc.home]}, CodexAuth: tc.own}
			if tc.managed {
				req.CodexHome = &struct {
					AuthJSON string `json:"authJson"`
				}{}
			}
			keep, err := keepLocalCodexHome(req, chat, r)
			if keep != tc.keep || (err != nil) != tc.fail {
				t.Fatalf("keep=%v err=%v; want keep=%v failure=%v", keep, err, tc.keep, tc.fail)
			}
		})
	}
}
