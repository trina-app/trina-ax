package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// QA TC-2310: an app-only update switches app/current under a running launcher and the server prunes the old version
// folder. A sign-in started after that (claude-login setup-token, codex-login: beginLoginAs, no bridge set by a turn)
// must bind the bridge of the version app/current points to now, not the one resolved when the launcher started.
func TestSignInAfterAppUpdateUsesTheNewBridge(t *testing.T) {
	base := t.TempDir()
	app := filepath.Join(base, "app")
	mkBridge := func(v string) string {
		p := filepath.Join(app, "versions", v, "native", "mycel-bridge")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("bridge "+v), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	switchTo := func(v string) {
		tmp := filepath.Join(app, "current.new")
		_ = os.Remove(tmp)
		if err := os.Symlink(filepath.Join("versions", v), tmp); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(tmp, filepath.Join(app, "current")); err != nil {
			t.Fatal(err)
		}
	}
	engine := filepath.Join(base, "engines", "claude", "current", "claude")
	if err := os.MkdirAll(filepath.Dir(engine), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engine, []byte("engine"), 0o755); err != nil {
		t.Fatal(err)
	}

	saved := struct {
		bridge, bwrap, helper, etc, ca, sock, landlock string
		lxBwrap                                        bool
		lxBridge                                       string
		ldso                                           map[string]string
	}{*bridgePath, *bwrapBin, *sandboxHelper, *sandboxEtc, *caBundle, *toolsSock, *landlockMode, lx.bwrap, lx.bridgeReal, lx.ldso}
	t.Cleanup(func() {
		*bridgePath, *bwrapBin, *sandboxHelper, *sandboxEtc, *caBundle, *toolsSock, *landlockMode = saved.bridge, saved.bwrap, saved.helper, saved.etc, saved.ca, saved.sock, saved.landlock
		lx.bwrap, lx.bridgeReal, lx.ldso = saved.lxBwrap, saved.lxBridge, saved.ldso
	})

	// the launcher starts on 0.5.3 (setupBwrap resolves --bridge once)
	old := mkBridge("0.5.3")
	switchTo("0.5.3")
	*bridgePath = filepath.Join(app, "current", "native", "mycel-bridge")
	*bwrapBin, *sandboxHelper, *sandboxEtc = "/usr/bin/bwrap", filepath.Join(base, "root", "mycel-sandbox"), filepath.Join(base, "root", "sandbox-etc")
	*caBundle, *toolsSock, *landlockMode = "/etc/ssl/certs/ca-certificates.crt", filepath.Join(base, "run", "tools", "tools.sock"), "required"
	lx.bwrap, lx.ldso = true, map[string]string{engine: ""}
	var err error
	if lx.bridgeReal, err = filepath.EvalSymlinks(*bridgePath); err != nil {
		t.Fatal(err)
	}
	if lx.bridgeReal != old {
		t.Fatalf("start: %s", lx.bridgeReal)
	}

	// an app-only update: 0.5.4 comes in, app/current switches, the launcher keeps running, 0.5.3 is pruned
	fresh := mkBridge("0.5.4")
	switchTo("0.5.4")
	if err := os.RemoveAll(filepath.Join(app, "versions", "0.5.3")); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"claude-login", "login"} {
		te := &turnEnv{chat: filepath.Join(base, "agent", name), login: true} // what beginLoginAs builds
		cmd, _, err := te.command(engine, []string{"setup-token"}, te.chat, te.chat)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		argv := strings.Join(cmd.Args, " ")
		if strings.Contains(argv, "versions/0.5.3") {
			t.Fatalf("%s binds the pruned bridge: %s", name, argv)
		}
		if !strings.Contains(argv, "--ro-bind "+fresh+" "+*bridgePath) || !strings.Contains(argv, "--exec-allow "+fresh) {
			t.Fatalf("%s does not bind the new bridge %s: %s", name, fresh, argv)
		}
	}

	// a chat turn keeps the bridge main.go resolved for it (the one its mcp.json names)
	te := &turnEnv{chat: filepath.Join(base, "agent", "c_1"), bridge: fresh}
	if got := te.bridgeReal(); got != fresh {
		t.Fatalf("turn bridge %s", got)
	}

	// app/current broken (no folder behind it): the start path is the last resort, never an empty one
	if err := os.RemoveAll(filepath.Join(app, "versions", "0.5.4")); err != nil {
		t.Fatal(err)
	}
	if got := (&turnEnv{login: true}).bridgeReal(); got != old {
		t.Fatalf("fallback %s", got)
	}
}
