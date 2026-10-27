package main

import (
	"strings"
	"testing"
)

func goldenParams() bwrapParams {
	return bwrapParams{
		EngineDir: "/var/lib/mycel/app/engines/claude/3f2a", EngineReal: "/var/lib/mycel/app/engines/claude/3f2a/claude",
		Bridge: "/var/lib/mycel/app/current/native/mycel-bridge", BridgeReal: "/var/lib/mycel/app/versions/0.3.0/native/mycel-bridge",
		Helper: "/var/lib/mycel/root/mycel-sandbox", ToolsSock: "/var/lib/mycel/run/tools/tools.sock", Chat: "/var/lib/mycel/agent/c_1",
		EtcDir: "/var/lib/mycel/root/sandbox-etc", CA: "/etc/ssl/certs/ca-certificates.crt", Landlock: "required-scoped",
		Ldso: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
		Libs: []libMount{{path: "/lib", link: "usr/lib", exists: true}, {path: "/lib64", link: "usr/lib64", exists: true},
			{path: "/lib32"}, {path: "/libx32", isDir: true, exists: true}},
		UsrLib64: true,
		Args:     []string{"-p", "--mcp-config", "./.turn/mcp.json"},
	}
}

// spec 3.3.3, exact argv (Claude turn on Debian 13 amd64)
const goldenClaude = `--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try --disable-userns --die-with-parent ` +
	`--cap-drop ALL --hostname mycel-turn --ro-bind /usr/lib /usr/lib --ro-bind-try /usr/lib64 /usr/lib64 ` +
	`--symlink usr/lib /lib --symlink usr/lib64 /lib64 --ro-bind-try /libx32 /libx32 ` +
	`--ro-bind /etc/ld.so.cache /etc/ld.so.cache --ro-bind /var/lib/mycel/root/sandbox-etc/passwd /etc/passwd ` +
	`--ro-bind /var/lib/mycel/root/sandbox-etc/group /etc/group --ro-bind /var/lib/mycel/root/sandbox-etc/hosts /etc/hosts ` +
	`--ro-bind /var/lib/mycel/root/sandbox-etc/nsswitch.conf /etc/nsswitch.conf --ro-bind /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem ` +
	`--ro-bind-try /usr/share/zoneinfo /usr/share/zoneinfo --proc /proc --dev /dev --size 67108864 --tmpfs /dev/shm ` +
	`--ro-bind /var/lib/mycel/app/engines/claude/3f2a /var/lib/mycel/app/engines/claude/3f2a ` +
	`--ro-bind /var/lib/mycel/app/versions/0.3.0/native/mycel-bridge /var/lib/mycel/app/current/native/mycel-bridge ` +
	`--ro-bind /var/lib/mycel/root/mycel-sandbox /.sbx/mycel-sandbox ` +
	`--ro-bind /var/lib/mycel/run/tools/tools.sock /var/lib/mycel/run/tools/tools.sock ` +
	`--bind /var/lib/mycel/agent/c_1 /var/lib/mycel/agent/c_1 ` +
	// the bridge's resolved path too: the engine starts it by that path (main.go run, mcp.json)
	`--ro-bind /var/lib/mycel/app/versions/0.3.0/native/mycel-bridge /var/lib/mycel/app/versions/0.3.0/native/mycel-bridge ` +
	`--remount-ro / --chdir /var/lib/mycel/agent/c_1 -- ` +
	`/.sbx/mycel-sandbox exec --landlock required-scoped --exec-allow /var/lib/mycel/app/engines/claude/3f2a ` +
	`--exec-allow /var/lib/mycel/app/current/native/mycel-bridge --exec-allow /var/lib/mycel/app/versions/0.3.0/native/mycel-bridge ` +
	`--exec-allow /usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 ` +
	`-- /var/lib/mycel/app/engines/claude/3f2a/claude -p --mcp-config ./.turn/mcp.json`

func TestBwrapArgsClaudeGolden(t *testing.T) {
	a, err := buildBwrapArgs(goldenParams())
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(a, " "); got != goldenClaude {
		t.Fatalf("argv differs:\n got %s\nwant %s", got, goldenClaude)
	}
	// no --new-session (D7: the gate's sid check), nothing of /tmp, /usr/bin, /etc/resolv.conf, /sys, /run
	for _, bad := range []string{"--new-session", "/tmp", "/usr/bin", "resolv.conf", "/sys", "/run ", "codex-auth", "--unshare-net"} {
		if strings.Contains(" "+strings.Join(a, " ")+" ", bad) {
			t.Errorf("argv contains %q", bad)
		}
	}
}

func TestBwrapArgsResolvedToolsSocket(t *testing.T) {
	p := goldenParams()
	p.ToolsSockReal = "/run/mycel/tools.sock" // the configured path goes through a link
	a, err := buildBwrapArgs(p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(a, " "), "--ro-bind /run/mycel/tools.sock /run/mycel/tools.sock") {
		t.Fatalf("the resolved tools socket is not in the sandbox: %v", a)
	}
	p.ToolsSockReal = p.ToolsSock // no link: nothing extra
	b, _ := buildBwrapArgs(p)
	if strings.Join(b, " ") != goldenClaude {
		t.Fatalf("argv changed without a link")
	}
}

func TestBwrapArgsCodex(t *testing.T) {
	p := goldenParams()
	p.Codex, p.Ldso, p.AllowListen = true, "", true
	p.EngineDir, p.EngineReal = "/var/lib/mycel/app/engines/codex/9b1c", "/var/lib/mycel/app/engines/codex/9b1c/codex"
	a, err := buildBwrapArgs(p)
	if err != nil {
		t.Fatal(err)
	}
	s := strings.Join(a, " ")
	for _, f := range []string{"config.toml", "models_cache.json", "catalog.json", "AGENTS.md", "hooks.json"} {
		if !strings.Contains(s, "--ro-bind /var/lib/mycel/root/sandbox-etc/empty /var/lib/mycel/agent/c_1/.codex/"+f+" ") {
			t.Errorf("no lock bind for %s", f)
		}
	}
	for _, d := range []string{"skills", "plugins"} {
		if !strings.Contains(s, "--ro-bind /var/lib/mycel/root/sandbox-etc/empty.d /var/lib/mycel/agent/c_1/.codex/"+d+" ") {
			t.Errorf("no lock bind for %s", d)
		}
	}
	// the lock binds come after the chat bind (they are mounted on top of it) and before the remount
	if strings.Index(s, ".codex/config.toml") < strings.Index(s, "--bind /var/lib/mycel/agent/c_1") || strings.Index(s, ".codex/plugins") > strings.Index(s, "--remount-ro") {
		t.Error("lock binds out of order")
	}
	if !strings.Contains(s, "--allow-listen -- /var/lib/mycel/app/engines/codex/9b1c/codex") || strings.Contains(s, "ld-linux") {
		t.Errorf("static engine / allow-listen wrong: %s", s)
	}
}

func TestBwrapArgsRefusesBadPaths(t *testing.T) {
	for _, mut := range []func(*bwrapParams){
		func(p *bwrapParams) { p.Chat = "relative/chat" },
		func(p *bwrapParams) { p.Chat = "/var/lib/mycel/agent/c_1/../c_2" },
		func(p *bwrapParams) { p.Chat = "/var/lib/mycel/agent/c\n1" },
		func(p *bwrapParams) { p.ToolsSock = "" },
		func(p *bwrapParams) { p.Ldso = "ld.so" },
	} {
		p := goldenParams()
		mut(&p)
		if _, err := buildBwrapArgs(p); err == nil {
			t.Errorf("accepted %+v", p)
		}
	}
}

func TestListenInodesParsesProcNetTCP(t *testing.T) {
	// smoke: the parser runs on this machine's table without error (port 1 is never ours)
	if n := listenInodes(1, 0); len(n) != 0 {
		t.Fatalf("unexpected listener on port 1: %v", n)
	}
}
