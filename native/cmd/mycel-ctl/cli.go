// mycel-ctl: the root tool of a Linux install (linux-runtime spec 3.6.5). Static Go, installed as
// <base>/root/mycel-ctl (root 755) with a link /usr/local/sbin/mycel-ctl. Everything that needs root after the
// installer ran goes through it: the engine firewall (nftables), resource plans, root-level updates, status for the
// control plane, the engine account's Codex login, and a small supervisor for systems without systemd.
//
// Principles (same as the macOS installer, scripts/install-macos.sh:47-52): root runs only what is in <base>/root/ and
// the system's own tools; it never runs a program from app/, data/ or the team folder, and it never writes through a
// folder the server or engine account owns. Every subcommand first checks that <base>, <base>/root and <base>/run are
// root-owned and not writable by group or others.
//
//	mycel-ctl preflight [--json] [--hosted]
//	mycel-ctl firewall apply|status|remove [--base B] [--nft PATH]
//	mycel-ctl verify-bundle DIR|FILE [--allow-unsigned] [--pubkey K]...
//	mycel-ctl status [--json]
//	mycel-ctl apply-plan < plan.json
//	mycel-ctl update [--version V | --bundle FILE] [--only-if-needs-root] [--json] [--max-wait 600]
//	mycel-ctl render-units [--templates DIR] [--out DIR]
//	mycel-ctl safe-ops on|off|status [--json] [--no-restart] [--max-wait S]
//	mycel-ctl codex-login
//	mycel-ctl supervise
//	mycel-ctl notices-set | set-server-config | relay-registration-set | relay-key-proof | idle-wait | prepare-stop |
//	          backup-prepare | backup-upload | export | reset-link | setup-token-rotate | credentials-escrow-out
//	          (the hosted service's tenant commands, tenant.go)
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// rootUID is the owner every root-only path must have and the uid every root-only subcommand must run as. Tests set
// it to their own uid.
var rootUID = 0

const defaultBase = "/var/lib/mycel"

// env is what one invocation works with (flags shared by the subcommands).
type env struct {
	base      string
	nft       string
	systemctl string
	stdout    io.Writer
	stderr    io.Writer
	stdin     io.Reader
	now       func() time.Time
}

func newEnv() *env {
	return &env{base: defaultBase, nft: "/usr/sbin/nft", systemctl: "/usr/bin/systemctl", stdout: os.Stdout, stderr: os.Stderr, stdin: os.Stdin, now: time.Now}
}

// flags adds the shared flags to a subcommand's flag set.
func (e *env) flags(fs *flag.FlagSet) {
	fs.StringVar(&e.base, "base", e.base, "install base (default /var/lib/mycel)")
	fs.StringVar(&e.nft, "nft", e.nft, "nft binary")
	fs.StringVar(&e.systemctl, "systemctl", e.systemctl, "systemctl binary")
}

func (e *env) root(p ...string) string {
	return filepath.Join(append([]string{e.base, "root"}, p...)...)
}

const usage = `usage: mycel-ctl <command> [--base /var/lib/mycel]
  preflight [--json] [--hosted]          check this machine (kernel, Landlock, cgroup v2, user namespaces, nft, Yama)
  firewall apply|status|remove           load / check / remove the engine firewall (nftables), write run/firewall.json
  verify-bundle DIR|FILE                 check a release (manifest + signature); FILE = <v>-linux-<arch>.tar.zst
  status [--json]                        versions, units, firewall, plan, disk, health, update history
  apply-plan < plan.json                 install a resource plan and apply it to the units
  update [--version V|--bundle FILE]     update root files and the app (--only-if-needs-root, --json, --max-wait 600)
  render-units [--templates D] [--out D] write the systemd units from root/systemd/*.in
  safe-ops on|off|status                 safe operations 1A: flag, root-owned programs, bounded <id>.slice, restart
  codex-login                            sign the engine account in to Codex (device code)
  supervise                              run firewall, launcher and server without systemd (tests, not supported)
tenant commands of the hosted service (ax-hostd, control-plane 3.5.3; every one takes --json and prints one JSON object):
  status --json | apply-plan | update --version V | notices-set | set-server-config | relay-registration-set
  relay-key-proof --team-id T | idle-wait --max S | prepare-stop --grace S | backup-prepare --kind K [--local-id ID]
  backup-upload | export | reset-link --owner|--username U | setup-token-rotate | credentials-escrow-out --recipient R`

// run is the whole program; main() (Linux) exits with its result.
func run(args []string) int { return runEnv(newEnv(), args) }

// runEnv runs one command with the given environment (tests: buffers and fakes).
func runEnv(e *env, args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(e.stderr, usage)
		return 2
	}
	cmd, rest := args[0], args[1:]
	var err error
	code := 0
	switch cmd {
	case "preflight":
		code, err = cmdPreflight(e, rest)
	case "firewall":
		code, err = cmdFirewall(e, rest)
	case "verify-bundle":
		code, err = cmdVerifyBundle(e, rest)
	case "status":
		code, err = cmdStatus(e, rest)
	case "apply-plan":
		code, err = cmdApplyPlan(e, rest)
	case "update":
		code, err = cmdUpdate(e, rest)
	case "render-units":
		code, err = cmdRenderUnits(e, rest)
	case "safe-ops":
		code, err = cmdSafeOps(e, rest)
	case "codex-login":
		code, err = cmdCodexLogin(e, rest)
	case "supervise":
		code, err = cmdSupervise(e, rest)
	case "launcher-status-as-server": // internal: re-executed as the server account (update.go launcherLiveTurns)
		code, err = cmdLauncherStatusChild(e, rest)
	// tenant commands of the hosted service (tenant.go; control-plane 3.5.3)
	case "notices-set":
		code, err = cmdNoticesSet(e, rest)
	case "set-server-config":
		code, err = cmdSetServerConfig(e, rest)
	case "relay-registration-set":
		code, err = cmdRelayRegistrationSet(e, rest)
	case "relay-key-proof":
		code, err = cmdRelayKeyProof(e, rest)
	case "idle-wait":
		code, err = cmdIdleWait(e, rest)
	case "prepare-stop":
		code, err = cmdPrepareStop(e, rest)
	case "backup-prepare":
		code, err = cmdBackupPrepare(e, rest)
	case "backup-upload":
		code, err = cmdBackupUpload(e, rest)
	case "export":
		code, err = cmdExport(e, rest)
	case "reset-link":
		code, err = cmdResetLink(e, rest)
	case "setup-token-rotate":
		code, err = cmdSetupTokenRotate(e, rest)
	case "credentials-escrow-out":
		code, err = cmdCredentialsEscrowOut(e, rest)
	case "server-write": // internal: re-executed as the server account (tenant.go asServer)
		code, err = cmdServerWrite(e, rest)
	case "server-config-merge": // internal: re-executed as the server account
		code, err = cmdServerConfigMerge(e, rest)
	case "-h", "--help", "help":
		fmt.Fprintln(e.stdout, usage)
		return 0
	default:
		fmt.Fprintln(e.stderr, usage)
		return 2
	}
	if err != nil {
		fmt.Fprintln(e.stderr, "mycel-ctl "+cmd+":", err)
		var ue usageError
		if errors.As(err, &ue) {
			return 2
		}
		if code == 0 {
			code = 1
		}
	}
	return code
}

type usageError struct{ msg string }

func (u usageError) Error() string { return u.msg }

// requireRoot: root-only subcommands refuse other accounts (exit 2).
func requireRoot() error {
	if os.Geteuid() != rootUID {
		return usageError{"must run as root"}
	}
	return nil
}

// checkBase refuses to act when base, base/root or base/run could be changed by someone other than root: a root job
// that reads its configuration from, or writes into, a folder another account controls can be redirected.
func checkBase(base string) error {
	if !filepath.IsAbs(base) || filepath.Clean(base) != base {
		return fmt.Errorf("--base must be a clean absolute path")
	}
	for _, p := range []string{base, filepath.Join(base, "root"), filepath.Join(base, "run")} {
		if err := rootOwnedDir(p); err != nil {
			return err
		}
	}
	return nil
}

func rootOwnedDir(p string) error {
	var st syscall.Stat_t
	if err := syscall.Lstat(p, &st); err != nil {
		return fmt.Errorf("%s: %v", p, err)
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return fmt.Errorf("%s is not a folder (or is a link)", p)
	}
	if int(st.Uid) != rootUID || st.Mode&0o022 != 0 {
		return fmt.Errorf("%s must be owned by root and not writable by group or others", p)
	}
	return nil
}

// readRootFile reads a small configuration file root wrote: no link, root-owned, not writable by others.
func readRootFile(p string, max int64) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return nil, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Size > max {
		return nil, fmt.Errorf("%s is not a small regular file", p)
	}
	if int(st.Uid) != rootUID || st.Mode&0o022 != 0 {
		return nil, fmt.Errorf("%s must be owned by root and not writable by group or others", p)
	}
	return io.ReadAll(io.LimitReader(f, max))
}

// writeRootFile replaces p atomically (temp file in the same root-owned folder, O_EXCL|O_NOFOLLOW, rename).
func writeRootFile(p string, b []byte, mode os.FileMode) error {
	tmp := filepath.Join(filepath.Dir(p), fmt.Sprintf(".%s.%d.tmp", filepath.Base(p), time.Now().UnixNano()))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func printJSON(w io.Writer, v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	fmt.Fprintln(w, string(b))
}

// positional splits "a b --flag x" so subcommands accept positional words before flags too.
func positional(args []string) (pos, flags []string) {
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			return pos, args[i:]
		}
		pos = append(pos, args[i])
	}
	return pos, nil
}
