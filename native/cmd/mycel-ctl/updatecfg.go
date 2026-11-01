package main

// How an install takes updates, and the two switches that used to stick (update audit 2026-11-01, P3). The installer's
// --no-auto-update and --allow-unsigned are kept in root/install.json and every repair and update inherits them; no
// installer flag turned them back, a plain repair turned a hand-enabled timer off again, and nothing showed either
// state. Now:
//
//	mycel-ctl auto-update on|off|status     [--json] [--no-restart] [--max-wait S]
//	mycel-ctl allow-unsigned on|off|status  [--json] [--no-restart] [--max-wait S]
//
// auto-update sets install.json autoUpdate, server.json update.auto (the app's own updates, written as the server
// account) and the <id>-update.timer together. allow-unsigned sets install.json allowUnsigned and renders the units
// again (the bootstrap's --allow-unsigned and the server's MYCEL_ALLOW_UNSIGNED come from it), so the file and the
// units agree; off is refused while the version that runs is not a verified release (the bootstrap would refuse to
// start it). Both restart the server when no answer runs (at most --max-wait seconds; auto-update never interrupts an
// answer for it: the app's own updater then follows at the server's next start). The installer has the same switches
// (--auto-update, --require-signed), `mycel-ctl status` and Admin > Diagnostics warn while either is off.

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/sys/unix"
	"mycel/native/internal/bundle"
)

// UpdateSettings is `status --detail --json`'s "updates" and the result of auto-update / allow-unsigned.
type UpdateSettings struct {
	// AutoUpdate is root/install.json autoUpdate (the installer's --no-auto-update / --auto-update)
	AutoUpdate bool `json:"autoUpdate"`
	// Timer is `systemctl is-enabled <id>-update.timer` ("" without systemd)
	Timer string `json:"timer,omitempty"`
	// AppAutoUpdate is config/server.json update.auto (the app's own updates of app-only releases); null: unreadable
	AppAutoUpdate *bool `json:"appAutoUpdate"`
	// AllowUnsigned is root/install.json allowUnsigned (the bootstrap and the app accept unsigned versions)
	AllowUnsigned bool `json:"allowUnsigned"`
	// UnitsMatch: the installed units are what root/systemd and install.json render to (null without systemd)
	UnitsMatch *bool `json:"unitsMatch,omitempty"`
	// Window and TimeZone: when the update timer may update (the team's update window, schedule.go); WindowNote says
	// why it is not the team's own ("" when it is)
	Window     string `json:"window,omitempty"`
	TimeZone   string `json:"timeZone,omitempty"`
	WindowNote string `json:"windowNote,omitempty"`
	// Deferred: a root update waits for a quiet moment in the team's window (schedule.go)
	Deferred *deferredUpdate `json:"deferred,omitempty"`
	Warnings []string        `json:"warnings,omitempty"`
	Notes    []string        `json:"notes,omitempty"`
}

// autoUpdatesOn: every part of automatic updates is on (a hosted server has none of its own: the control plane updates).
func (s *UpdateSettings) autoUpdatesOn(systemd bool) bool {
	return s.AutoUpdate && (!systemd || s.Timer == "enabled") && (s.AppAutoUpdate == nil || *s.AppAutoUpdate)
}

func collectUpdateSettings(e *env, in *Install) *UpdateSettings {
	s := &UpdateSettings{AutoUpdate: in.AutoUpdate, AllowUnsigned: in.AllowUnsigned, Deferred: readDeferred(e)}
	systemd := in.Systemd && fileExists(systemdRunDir)
	if systemd {
		out, _ := exec.Command(e.systemctl, "is-enabled", in.ID+"-update.timer").Output() // exit 1 when disabled
		s.Timer = strings.TrimSpace(string(out))
		if s.Timer == "" {
			s.Timer = "unknown"
		}
		m := unitsMatch(in, e.root("systemd"), systemdUnitDir)
		s.UnitsMatch = m
	}
	if !in.Hosted {
		// the team's window and zone, from the running app (admin.js update-window, as the server account)
		u := &updater{e: e, in: in}
		u.runAsSrv = u.runAsServer
		if statusScheduleHook != nil {
			statusScheduleHook(u)
		}
		sc := u.readSchedule()
		s.Window, s.TimeZone, s.WindowNote = sc.w.String(), sc.zone, sc.note
	}
	// the server account's file: no link, a regular file, small (it could name a device)
	if b, err := readSmall(filepath.Join(in.Base, "config", "server.json"), 256<<10); err == nil {
		var c struct {
			Update struct {
				Auto *bool `json:"auto"`
			} `json:"update"`
		}
		if json.Unmarshal(b, &c) == nil && c.Update.Auto != nil {
			s.AppAutoUpdate = c.Update.Auto
		}
	}
	if !in.Hosted && !s.autoUpdatesOn(systemd) {
		var off []string
		if !s.AutoUpdate {
			off = append(off, "install.json autoUpdate false")
		}
		if systemd && s.Timer != "enabled" {
			off = append(off, in.ID+"-update.timer "+s.Timer)
		}
		if s.AppAutoUpdate != nil && !*s.AppAutoUpdate {
			off = append(off, "server.json update.auto false")
		}
		s.Warnings = append(s.Warnings, "automatic updates are off ("+strings.Join(off, ", ")+"): new versions come only with `sudo mycel-ctl update`; `sudo mycel-ctl auto-update on` turns them on")
	}
	if s.AllowUnsigned {
		s.Warnings = append(s.Warnings, "this server accepts unsigned versions (installed with --allow-unsigned, for development builds): `sudo mycel-ctl allow-unsigned off` accepts signed releases only")
	}
	if s.UnitsMatch != nil && !*s.UnitsMatch {
		s.Warnings = append(s.Warnings, fmt.Sprintf("the systemd units differ from root/install.json: run `sudo mycel-ctl render-units`, then `sudo systemctl restart %s-server`", in.ID))
	}
	return s
}

// statusScheduleHook replaces the admin.js call of status (tests).
var statusScheduleHook func(u *updater)

// unitsMatch renders the units into a private folder and compares them with the installed ones (nil: cannot tell).
func unitsMatch(in *Install, templates, installed string) *bool {
	tmp, err := os.MkdirTemp("", "mycel-units-")
	if err != nil {
		return nil
	}
	defer os.RemoveAll(tmp)
	names, _, err := renderUnits(in, templates, tmp)
	if err != nil {
		return nil
	}
	same := true
	for _, n := range names {
		want, _ := os.ReadFile(filepath.Join(tmp, n))
		have, err := os.ReadFile(filepath.Join(installed, n))
		if err != nil || !bytes.Equal(want, have) {
			same = false
		}
	}
	return &same
}

// setInstallBool sets one true/false of root/install.json. The line is replaced where it is (the installer reads the
// file line by line, scripts/install-linux.sh j()); a file without it is written again with every key it has.
func setInstallBool(e *env, key string, v bool) (*Install, error) {
	p := e.root("install.json")
	b, err := readRootFile(p, 64<<10)
	if err != nil {
		return nil, err
	}
	val := fmt.Sprint(v)
	re := regexp.MustCompile(`("` + regexp.QuoteMeta(key) + `"\s*:\s*)(true|false)`)
	var nb []byte
	if len(re.FindAllIndex(b, -1)) == 1 {
		nb = re.ReplaceAll(b, []byte("${1}"+val))
	} else {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, fmt.Errorf("install.json: %v", err)
		}
		m[key] = json.RawMessage(val)
		if nb, err = json.MarshalIndent(m, "", "  "); err != nil {
			return nil, err
		}
		nb = append(nb, '\n')
	}
	in, err := parseInstall(nb)
	if err != nil {
		return nil, err
	}
	if (key == "autoUpdate" && in.AutoUpdate != v) || (key == "allowUnsigned" && in.AllowUnsigned != v) {
		return nil, fmt.Errorf("install.json: %s not set", key)
	}
	if err := writeRootFile(p, nb, 0o644); err != nil {
		return nil, err
	}
	return in, nil
}

// hooks (tests): running turns, this program run again as the server account, the pause between two looks
var (
	settingsLiveTurns = func(e *env, in *Install) (int, error) { return (&updater{e: e, in: in}).launcherLiveTurns() }
	settingsAsServer  = func(e *env, in *Install, args ...string) error { return (&tenant{e: e, in: in}).asServer(nil, args...) }
	settingsSleep     = time.Sleep
)

// settingsRestart restarts the server unit when no answer runs (at most maxWait); force: after maxWait anyway.
func settingsRestart(e *env, in *Install, maxWait time.Duration, force bool) (bool, string, error) {
	deadline := e.now().Add(maxWait)
	n := 0
	for {
		c, err := settingsLiveTurns(e, in)
		// the server's own backup or restore counts like an answer (status/status.json)
		if m := (&updater{e: e, in: in}).serverMaintenance(); m != "" && c == 0 {
			c = 1
		}
		if err == nil && c == 0 {
			n = 0
			break
		}
		n = c
		if !e.now().Before(deadline) {
			break
		}
		settingsSleep(2 * time.Second)
	}
	if n > 0 && !force {
		return false, fmt.Sprintf("not restarted: %d answer(s) still running; the server takes the change at its next start (`sudo systemctl restart %s-server`)", n, in.ID), nil
	}
	if out, err := exec.Command(e.systemctl, "restart", in.ID+"-server.service").CombinedOutput(); err != nil {
		return false, "", fmt.Errorf("restart server: %v %s", err, strings.TrimSpace(string(out)))
	}
	return true, "", nil
}

func cmdAutoUpdate(e *env, args []string) (int, error) {
	return cmdUpdateSwitch(e, args, "auto-update")
}

func cmdAllowUnsigned(e *env, args []string) (int, error) {
	return cmdUpdateSwitch(e, args, "allow-unsigned")
}

// verifyKeys are the keys `allow-unsigned off` checks the running version with (tests add theirs).
var verifyKeys = append([]string{}, bundle.ReleaseKeys...)

func cmdUpdateSwitch(e *env, args []string, name string) (int, error) {
	pos, rest := positional(args)
	if len(pos) != 1 || (pos[0] != "on" && pos[0] != "off" && pos[0] != "status") {
		return 2, usageError{name + " on|off|status [--json] [--no-restart] [--max-wait S]"}
	}
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	e.flags(fs)
	asJSON := fs.Bool("json", false, "JSON output")
	noRestart := fs.Bool("no-restart", false, "change the files only; restart the server yourself")
	maxWait := fs.Int("max-wait", 120, "seconds to wait for running answers before the server restarts")
	if err := fs.Parse(rest); err != nil {
		return 2, usageError{err.Error()}
	}
	if err := requireRoot(); err != nil {
		return 2, err
	}
	if err := checkBase(e.base); err != nil {
		return 1, err
	}
	in, err := loadInstall(e)
	if err != nil {
		return 1, err
	}
	systemd := in.Systemd && fileExists(systemdRunDir)
	var notes []string
	out := func(code int, err error) (int, error) {
		s := collectUpdateSettings(e, in)
		s.Notes = append(notes, s.Notes...)
		if *asJSON {
			printJSON(e.stdout, s)
		} else {
			printUpdateSettings(e.stdout, s, in, systemd)
		}
		return code, err
	}
	if pos[0] == "status" {
		return out(0, nil)
	}
	on := pos[0] == "on"
	restartForce := false
	switch name {
	case "auto-update":
		if in.Hosted {
			return 1, fmt.Errorf("a hosted server is updated by the hosting service's control plane, not by itself")
		}
		// server.json and the timer first, install.json last: a step that fails leaves install.json as it was, and
		// status shows what disagrees
		if err := settingsAsServer(e, in, "server-update-auto", "--auto="+fmt.Sprint(on)); err != nil {
			return 1, fmt.Errorf("server.json update.auto: %v", err)
		}
		if systemd {
			verb := map[bool]string{true: "enable", false: "disable"}[on]
			if o, err := exec.Command(e.systemctl, verb, "--now", in.ID+"-update.timer").CombinedOutput(); err != nil {
				return 1, fmt.Errorf("systemctl %s %s-update.timer: %v %s", verb, in.ID, err, strings.TrimSpace(string(o)))
			}
		}
		if in, err = setInstallBool(e, "autoUpdate", on); err != nil {
			return 1, err
		}
	case "allow-unsigned":
		if !on {
			// the bootstrap must still start what runs now: only a verified release
			v := currentVersion(e.base)
			if v == "" {
				return 1, fmt.Errorf("app/current names no version")
			}
			if _, err := bundle.VerifyDir(filepath.Join(e.base, "app", "versions", v), v, bundle.Options{Keys: verifyKeys}); err != nil {
				return 1, fmt.Errorf("the version that runs (%s) is not a verified release (%v): install a signed release first (`sudo mycel-ctl update`), then run this again", v, err)
			}
		}
		if in, err = setInstallBool(e, "allowUnsigned", on); err != nil {
			return 1, err
		}
		restartForce = true // the bootstrap's arguments and the server's environment: the setting is only real after it
		if on {
			notes = append(notes, "unsigned versions are accepted now: use this for development builds only")
		}
	}
	if systemd {
		_, changed, err := renderUnits(in, e.root("systemd"), systemdUnitDir)
		if err != nil {
			return 1, fmt.Errorf("units: %v", err)
		}
		if changed {
			if o, err := exec.Command(e.systemctl, "daemon-reload").CombinedOutput(); err != nil {
				return 1, fmt.Errorf("daemon-reload: %v %s", err, o)
			}
		}
		if *noRestart {
			notes = append(notes, fmt.Sprintf("not restarted: the server takes the change at its next start (`sudo systemctl restart %s-server`)", in.ID))
		} else if restarted, why, err := settingsRestart(e, in, time.Duration(*maxWait)*time.Second, restartForce); err != nil {
			return 1, err
		} else if !restarted {
			notes = append(notes, why)
		} else {
			notes = append(notes, "the server restarted with the new setting")
		}
	} else {
		notes = append(notes, "no systemd: restart `mycel-ctl supervise` to apply")
	}
	return out(0, nil)
}

func printUpdateSettings(w io.Writer, s *UpdateSettings, in *Install, systemd bool) {
	switch {
	case in.Hosted:
		fmt.Fprintln(w, "  automatic updates: by the hosting service's control plane")
	case s.autoUpdatesOn(systemd):
		win := "the team's update window"
		if s.Window != "" {
			win += " " + s.Window + " " + s.TimeZone
			if s.WindowNote != "" {
				win += " (" + s.WindowNote + ")"
			}
		}
		fmt.Fprintf(w, "  automatic updates: on (root updates inside %s when no answer runs, checked every 15 minutes)\n", win)
	default:
		fmt.Fprintln(w, "  automatic updates: OFF")
	}
	fmt.Fprintf(w, "  unsigned versions: %s\n", map[bool]string{true: "ALLOWED", false: "refused (signed releases only)"}[s.AllowUnsigned])
	if d := s.Deferred; d != nil {
		fmt.Fprintf(w, "  root update to %s waits for a quiet moment since %s (%d answer(s) were running)\n", d.Version, d.Since.Format(time.RFC3339), d.Turns)
	}
	for _, x := range s.Warnings {
		fmt.Fprintln(w, "  WARNING: "+x)
	}
	for _, n := range s.Notes {
		fmt.Fprintln(w, "  note: "+n)
	}
}

// cmdServerUpdateAuto (internal, as the server account): config/server.json update.auto = --auto, every other key kept.
func cmdServerUpdateAuto(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("server-update-auto", flag.ContinueOnError)
	e.flags(fs)
	auto := fs.Bool("auto", false, "update.auto")
	if err := fs.Parse(args); err != nil {
		return 2, usageError{err.Error()}
	}
	if os.Geteuid() == 0 {
		return 2, usageError{"internal: as the server account"}
	}
	p := filepath.Join(e.base, "config", "server.json")
	cur, err := readOwnFile(p, 256<<10)
	if err != nil {
		return 1, err
	}
	var cfg map[string]any
	dec := json.NewDecoder(bytes.NewReader(cur))
	dec.UseNumber()
	if err := dec.Decode(&cfg); err != nil || cfg == nil {
		return 1, fmt.Errorf("server.json is not a JSON object")
	}
	up, ok := cfg["update"].(map[string]any)
	if !ok {
		up = map[string]any{}
		cfg["update"] = up
	}
	up["auto"] = *auto
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return 1, err
	}
	var st unix.Stat_t
	mode := os.FileMode(0o600)
	if unix.Lstat(p, &st) == nil {
		mode = os.FileMode(st.Mode & 0o777)
	}
	return 0, writeOwnFile(p, append(b, '\n'), mode)
}
