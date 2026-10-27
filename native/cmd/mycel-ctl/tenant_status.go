package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// TenantStatus is `mycel-ctl status --json`: what ax-hostd reports for this tenant every 60 s (control-plane 3.5.3,
// shared/src/cloud-protocol/tenant-commands.ts TenantStatus). The contract is STRICT: exactly these fields, no names,
// mail addresses, IPs, chat content or tokens; a field more and the control plane drops the whole status.
type TenantStatus struct {
	At                  string            `json:"at"`
	KitVersion          string            `json:"kitVersion"`
	RootVersion         string            `json:"rootVersion"`
	App                 TenantApp         `json:"app"`
	SetupNeeded         *bool             `json:"setupNeeded"`
	ActiveMembers       *int              `json:"activeMembers"`
	Queue               *TenantQueue      `json:"queue"`
	Relay               *TenantRelay      `json:"relay"`
	LastLocalBackup     *TenantBackup     `json:"lastLocalBackup"`
	LastUploadedLocalID *string           `json:"lastUploadedLocalId"`
	Overall             string            `json:"overall"`
	Checks              []TenantCheck     `json:"checks"`
	AI                  TenantAI          `json:"ai"`
	CredentialsKey      TenantKey         `json:"credentialsKey"`
	Resources           TenantResources   `json:"resources"`
	Update              TenantUpdateState `json:"update"`
}

type TenantApp struct {
	Version       *string `json:"version"`
	Health        string  `json:"health"` // ok | fail | down
	SchemaApplied *int    `json:"schemaApplied"`
	ReaderLevel   *int    `json:"readerLevel"`
	UptimeSec     *int    `json:"uptimeSec"`
}
type TenantQueue struct {
	Running int `json:"running"`
	Queued  int `json:"queued"`
}
type TenantRelay struct {
	State  string  `json:"state"`
	Detail *string `json:"detail"`
}
type TenantBackup struct {
	ID string `json:"id"`
	At string `json:"at"`
}
type TenantCheck struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}
type TenantAI struct {
	Claude string `json:"claude"`
	Codex  string `json:"codex"`
}
type TenantKey struct {
	Present bool `json:"present"`
	Version *int `json:"version"`
}
type TenantResources struct {
	MemCurrent        uint64  `json:"memCurrent"`
	MemMax            uint64  `json:"memMax"`
	OomKills          uint64  `json:"oomKills"`
	CPUPressureSome10 float64 `json:"cpuPressureSome10"`
	IOPressureSome10  float64 `json:"ioPressureSome10"`
	DiskUsed          uint64  `json:"diskUsed"`
	DiskTotal         uint64  `json:"diskTotal"`
}
type TenantUpdateState struct {
	Running bool    `json:"running"`
	Step    *string `json:"step"`
}

// appStatusPart is what admin.js cloud-status prints (server/src/system/cloud-tenant.ts AppTenantStatus).
type appStatusPart struct {
	SetupNeeded         *bool         `json:"setupNeeded"`
	ActiveMembers       *int          `json:"activeMembers"`
	Queue               *TenantQueue  `json:"queue"`
	Relay               *TenantRelay  `json:"relay"`
	LastLocalBackup     *TenantBackup `json:"lastLocalBackup"`
	LastUploadedLocalID *string       `json:"lastUploadedLocalId"`
	Overall             string        `json:"overall"`
	Checks              []TenantCheck `json:"checks"`
	AI                  *TenantAI     `json:"ai"`
	CredentialsKey      *TenantKey    `json:"credentialsKey"`
}

var (
	checkStatus = map[string]bool{"ok": true, "warn": true, "fail": true, "unknown": true}
	relayStates = map[string]bool{"connected": true, "connecting": true, "offline": true, "replaced": true, "not_registered": true, "disabled": true}
	aiStates    = map[string]bool{"none": true, "ok": true, "problem": true}
)

func limit(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// tenantStatus collects the status; the app's part comes from admin.js (as the server account), the rest from here.
func (t *tenant) tenantStatus() TenantStatus {
	s := TenantStatus{
		At: t.e.now().UTC().Format(time.RFC3339), KitVersion: limit(t.in.Version, 40), RootVersion: limit(rootVersion(t.e), 40),
		Overall: "unknown", Checks: []TenantCheck{}, AI: TenantAI{Claude: "none", Codex: "none"},
	}
	s.App = appHealth(t.in.Port, 3*time.Second)
	if raw, err := t.admin(nil, 8*time.Second, "cloud-status"); err == nil {
		var a appStatusPart
		if json.Unmarshal(raw, &a) == nil {
			s.SetupNeeded, s.ActiveMembers, s.Queue, s.LastLocalBackup = a.SetupNeeded, a.ActiveMembers, a.Queue, a.LastLocalBackup
			if a.LastUploadedLocalID != nil && localIDRE.MatchString(*a.LastUploadedLocalID) {
				s.LastUploadedLocalID = a.LastUploadedLocalID
			}
			if a.LastLocalBackup != nil && !localIDRE.MatchString(a.LastLocalBackup.ID) {
				s.LastLocalBackup = nil
			}
			if a.Relay != nil && relayStates[a.Relay.State] {
				r := *a.Relay
				if r.Detail != nil && !regexpCode.MatchString(*r.Detail) {
					r.Detail = nil
				}
				s.Relay = &r
			}
			if checkStatus[a.Overall] {
				s.Overall = a.Overall
			}
			for _, c := range a.Checks {
				if len(s.Checks) < 100 && checkIDRE.MatchString(c.ID) && checkStatus[c.Status] {
					s.Checks = append(s.Checks, c)
				}
			}
			if a.AI != nil && aiStates[a.AI.Claude] && aiStates[a.AI.Codex] {
				s.AI = *a.AI
			}
			if a.CredentialsKey != nil {
				s.CredentialsKey = *a.CredentialsKey
			}
		}
	}
	s.Resources = machineResources(t.in.Base)
	s.Update = TenantUpdateState{Running: updateRunning(t.e.root(".update.lock"))}
	return s
}

var (
	regexpCode = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)
	checkIDRE  = regexp.MustCompile(`^[a-z0-9_.-]{1,64}$`)
)

// appHealth: GET /api/health on this machine (version, schema and uptime are answered to local callers).
func appHealth(port int, timeout time.Duration) TenantApp {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://127.0.0.1:%d/api/health", port), nil)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		return TenantApp{Health: "down"}
	}
	defer r.Body.Close()
	var h struct {
		OK      bool    `json:"ok"`
		Version *string `json:"version"`
		Schema  *struct {
			Applied     int `json:"applied"`
			ReaderLevel int `json:"readerLevel"`
		} `json:"schema"`
		UptimeSec *float64 `json:"uptimeSec"`
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if json.Unmarshal(b, &h) != nil {
		return TenantApp{Health: "fail"}
	}
	a := TenantApp{Health: "fail"}
	if r.StatusCode == 200 && h.OK {
		a.Health = "ok"
	}
	if h.Version != nil {
		v := limit(*h.Version, 40)
		a.Version = &v
	}
	if h.Schema != nil {
		ap, rl := h.Schema.Applied, h.Schema.ReaderLevel
		a.SchemaApplied, a.ReaderLevel = &ap, &rl
	}
	if h.UptimeSec != nil {
		u := int(*h.UptimeSec)
		a.UptimeSec = &u
	}
	return a
}

// machineResources: memory, OOM kills and pressure of this VM (/proc), the data disk (statfs of the base).
func machineResources(base string) TenantResources {
	var r TenantResources
	if f, err := os.Open("/proc/meminfo"); err == nil {
		var total, avail uint64
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			fs := strings.Fields(sc.Text())
			if len(fs) < 2 {
				continue
			}
			n, _ := strconv.ParseUint(fs[1], 10, 64)
			switch fs[0] {
			case "MemTotal:":
				total = n * 1024
			case "MemAvailable:":
				avail = n * 1024
			}
		}
		f.Close()
		r.MemMax = total
		if total > avail {
			r.MemCurrent = total - avail
		}
	}
	if b, err := os.ReadFile("/proc/vmstat"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(l, "oom_kill "); ok {
				r.OomKills, _ = strconv.ParseUint(strings.TrimSpace(v), 10, 64)
			}
		}
	}
	r.CPUPressureSome10 = psiSome10("/proc/pressure/cpu")
	r.IOPressureSome10 = psiSome10("/proc/pressure/io")
	if total, _, used, err := diskUsage(base); err == nil {
		r.DiskTotal, r.DiskUsed = total, used
	}
	return r
}

// psiSome10: "some avg10=1.23 …" of a /proc/pressure file (0 without PSI).
func psiSome10(p string) float64 {
	b, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	for _, l := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(l, "some ") {
			continue
		}
		for _, f := range strings.Fields(l) {
			if v, ok := strings.CutPrefix(f, "avg10="); ok {
				x, _ := strconv.ParseFloat(v, 64)
				if x < 0 {
					x = 0
				}
				return x
			}
		}
	}
	return 0
}

// updateRunning: an update holds root/.update.lock (lockUpdate). A shared, non-blocking lock that fails means one runs.
func updateRunning(p string) bool {
	f, err := os.OpenFile(p, os.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	if err := unix.Flock(int(f.Fd()), unix.LOCK_SH|unix.LOCK_NB); err != nil {
		return true
	}
	_ = unix.Flock(int(f.Fd()), unix.LOCK_UN)
	return false
}
