package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"mycel/native/internal/fwstatus"
	"mycel/native/internal/plan"
)

// Status is `mycel-ctl status --json`: what the control plane collects from a tenant (spec 6.1 "상태 수집").
type Status struct {
	ID          string            `json:"id"`
	Base        string            `json:"base"`
	Version     string            `json:"version"`
	RootVersion string            `json:"rootVersion"`
	Units       map[string]string `json:"units"`
	Firewall    *fwstatus.Status  `json:"firewall"`
	FirewallOK  bool              `json:"firewallOk"`
	FirewallErr string            `json:"firewallError,omitempty"`
	Plan        *plan.Limits      `json:"plan"`
	PlanFile    bool              `json:"planFile"`
	PlanErr     string            `json:"planError,omitempty"`
	Disk        map[string]any    `json:"disk"`
	Health      map[string]any    `json:"health"`
	History     []json.RawMessage `json:"history"`
	// ServerStopped: app/state.json blocked — the bootstrap stopped starting the server because no version can run
	// (the old version cannot read the database a newer one migrated); nil while it runs or retries
	ServerStopped json.RawMessage `json:"serverStopped,omitempty"`
	// Updates: automatic updates and unsigned versions (update audit P3: both used to be invisible)
	Updates *UpdateSettings `json:"updates"`
	// SystemPackages: the one list's sync (sync.go); nil on a server from before the list
	SystemPackages *SystemPackagesStatus `json:"systemPackages,omitempty"`
}

// SystemPackagesStatus is the sync of the list in root/ (root/packages.synced against root/packages.json).
type SystemPackagesStatus struct {
	Summary string     `json:"summary"`
	List    string     `json:"list"`
	Pending bool       `json:"pending"`
	Synced  *SyncState `json:"synced"`
}

func cmdStatus(e *env, args []string) (int, error) {
	// --json: the hosted service's TenantStatus (tenant command `status`, tenant_status.go); --detail --json: the
	// install's own report below (units, firewall, plan limits, update history), for people and install tests
	t := newTenant(e, "status")
	asJSON := t.fs.Lookup("json")
	_ = asJSON.Value.Set("false")
	detail := t.fs.Bool("detail", false, "the install's detailed report (with --json: as JSON)")
	// opt-in by the reader: ax-hostd's TenantStatus is strict, so the block is sent only to a hostd that asks for it
	// (after its contract sync); without the flag the output keeps its exact earlier shape and admin.js skips the count
	onboarding := t.fs.Bool("onboarding", false, "with --json: add the team's first days (TenantStatus.onboarding)")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	in := t.in
	if asJSON.Value.String() == "true" && !*detail {
		return t.out(t.tenantStatus(*onboarding))
	}
	s := collectStatus(e, in)
	if asJSON.Value.String() == "true" {
		printJSON(e.stdout, s)
		return 0, nil
	}
	fmt.Fprintf(e.stdout, "%s at %s: version %s (root files %s)\n", s.ID, s.Base, orNone(s.Version), orNone(s.RootVersion))
	for _, n := range sortedKeys(s.Units) {
		fmt.Fprintf(e.stdout, "  %-28s %s\n", n, s.Units[n])
	}
	if s.FirewallOK {
		fmt.Fprintf(e.stdout, "  firewall: %d nftables rules, engine uid %d only to 127.0.0.1:%d\n", s.Firewall.Rules, s.Firewall.EngineUID, s.Firewall.ProxyPort)
	} else {
		fmt.Fprintf(e.stdout, "  firewall: NOT OK (%s)\n", s.FirewallErr)
	}
	if s.Plan != nil {
		fmt.Fprintf(e.stdout, "  plan: %s, %d concurrent, turn %d MiB, converters %d MiB\n", orNone(s.Plan.Plan), s.Plan.MaxConcurrency, s.Plan.TurnMaxMiB, s.Plan.ConvMiB)
	}
	fmt.Fprintf(e.stdout, "  disk: %v%% used\n  health: %v\n", s.Disk["percent"], s.Health)
	if s.ServerStopped != nil {
		var b struct{ Version, Since, Detail string }
		_ = json.Unmarshal(s.ServerStopped, &b)
		fmt.Fprintf(e.stdout, "  SERVER STOPPED at %s since %s: %s\n", b.Version, b.Since, b.Detail)
	}
	printUpdateSettings(e.stdout, s.Updates, in, in.Systemd && fileExists(systemdRunDir))
	if s.SystemPackages != nil {
		fmt.Fprintf(e.stdout, "  system packages: %s\n", s.SystemPackages.Summary)
	}
	return 0, nil
}

func sortedKeys(m map[string]string) []string {
	var k []string
	for x := range m {
		k = append(k, x)
	}
	sort.Strings(k)
	return k
}

func currentVersion(base string) string {
	t, err := os.Readlink(filepath.Join(base, "app", "current"))
	if err != nil {
		return ""
	}
	return filepath.Base(t)
}

func rootVersion(e *env) string {
	b, err := os.ReadFile(e.root("VERSION"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func unitNames(id string) []string {
	return []string{id + "-firewall.service", id + "-firewall.timer", id + "-launcher.service", id + "-server.service", id + "-update.service", id + "-update.timer"}
}

func collectStatus(e *env, in *Install) Status {
	s := Status{ID: in.ID, Base: in.Base, Version: currentVersion(in.Base), RootVersion: rootVersion(e), Units: map[string]string{}, History: []json.RawMessage{},
		Updates: collectUpdateSettings(e, in)}
	if line, synced, pending := syncStatus(e, e.now()); line != "" {
		s.SystemPackages = &SystemPackagesStatus{Summary: line, List: listSum(e), Pending: pending, Synced: synced}
	}
	if in.Systemd && fileExists(systemdRunDir) {
		for _, u := range unitNames(in.ID) {
			out, _ := exec.Command(e.systemctl, "is-active", u).Output()
			s.Units[u] = strings.TrimSpace(string(out))
		}
	}
	if fw, err := fwstatus.Read(e.statusFile(), rootUID); err != nil {
		s.FirewallErr = err.Error()
	} else {
		s.Firewall = fw
		if err := fw.Check(e.now(), fw.EngineUID, in.ProxyPort); err != nil {
			s.FirewallErr = err.Error()
		} else {
			s.FirewallOK = true
		}
	}
	if l, ok, err := plan.Load(e.root("plan.json")); err != nil {
		s.PlanErr = err.Error()
	} else {
		s.Plan, s.PlanFile = &l, ok
	}
	if total, free, used, err := diskUsage(in.Base); err == nil {
		pct := 0.0
		if total > 0 {
			pct = float64(int(float64(used)/float64(total)*1000)) / 10
		}
		s.Disk = map[string]any{"totalBytes": total, "freeBytes": free, "usedBytes": used, "percent": pct}
	} else {
		s.Disk = map[string]any{"error": err.Error()}
	}
	s.Health = health(in.Port, 3*time.Second)
	if b, err := os.ReadFile(filepath.Join(in.Base, "app", "state.json")); err == nil {
		var st struct {
			History []json.RawMessage `json:"history"`
			Blocked json.RawMessage   `json:"blocked"`
		}
		if json.Unmarshal(b, &st) == nil {
			if len(st.Blocked) > 0 && string(st.Blocked) != "null" {
				s.ServerStopped = st.Blocked
			}
			h := st.History
			if len(h) > 5 {
				h = h[len(h)-5:]
			}
			s.History = h
		}
	}
	return s
}

// health is GET http://127.0.0.1:<port>/api/health.
func health(port int, timeout time.Duration) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://127.0.0.1:%d/api/health", port), nil)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	defer r.Body.Close()
	var h map[string]any
	b, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if json.Unmarshal(b, &h) == nil && r.StatusCode == 503 && h["status"] == "migrating" {
		// the server is updating its database before it starts (server/src/system/migrate-start.ts)
		out := map[string]any{"ok": false, "status": "migrating", "error": "updating its database"}
		if v, ok := h["version"].(string); ok {
			out["version"] = v
		}
		return out
	}
	if h == nil || r.StatusCode != 200 {
		return map[string]any{"ok": false, "error": fmt.Sprintf("HTTP %d", r.StatusCode)}
	}
	out := map[string]any{"ok": h["ok"] == true}
	if v, ok := h["version"].(string); ok {
		out["version"] = v
	}
	return out
}
