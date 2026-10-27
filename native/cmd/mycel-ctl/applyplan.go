package main

import (
	"flag"
	"fmt"
	"io"
	"os/exec"
	"strings"

	"mycel/native/internal/plan"
)

// ApplyPlanResult is apply-plan's JSON.
type ApplyPlanResult struct {
	OK      bool        `json:"ok"`
	Limits  plan.Limits `json:"limits"`
	Systemd string      `json:"systemd"`
	Calls   [][]string  `json:"calls,omitempty"`
}

// cmdApplyPlan installs a resource plan (spec 3.8.5, D23): validated, written root-owned (the server account cannot
// raise its own limits), and applied to the running units with systemctl set-property (no restart; the launcher and
// the server re-read plan.json by its modification time before the next turn / within 60 s).
func cmdApplyPlan(e *env, args []string) (int, error) {
	fs := flag.NewFlagSet("apply-plan", flag.ContinueOnError)
	e.flags(fs)
	fs.Bool("json", true, "JSON output (always; the tenant command passes it)")
	if err := fs.Parse(args); err != nil {
		return 2, usageError{err.Error()}
	}
	if err := requireRoot(); err != nil {
		return 2, err
	}
	if err := checkBase(e.base); err != nil {
		return 1, err
	}
	b, err := io.ReadAll(io.LimitReader(e.stdin, plan.MaxFileBytes+1))
	if err != nil {
		return 1, err
	}
	p, err := plan.Parse(b)
	if err != nil {
		return 1, err
	}
	in, err := loadInstall(e)
	if err != nil {
		return 1, err
	}
	if err := writeRootFile(e.root("plan.json"), b, 0o644); err != nil {
		return 1, err
	}
	l := plan.Compute(p)
	res := ApplyPlanResult{OK: true, Limits: l}
	if !in.Systemd || !fileExists(systemdRunDir) {
		res.Systemd = "skipped: no systemd (the limits apply to the next turns through plan.json)"
		printJSON(e.stdout, res)
		return 0, nil
	}
	res.Calls = setPropertyCalls(in.ID, l)
	for _, c := range res.Calls {
		if out, err := exec.Command(e.systemctl, c...).CombinedOutput(); err != nil {
			res.OK = false
			res.Systemd = fmt.Sprintf("systemctl %s: %v %s", strings.Join(c, " "), err, strings.TrimSpace(string(out)))
			printJSON(e.stdout, res)
			return 1, fmt.Errorf("%s", res.Systemd)
		}
	}
	res.Systemd = "applied"
	// the server reads plan.json again now (seats, concurrency, retention) instead of at its next 60 s check; the
	// bootstrap passes SIGHUP to the server only
	_ = exec.Command(e.systemctl, "kill", "--kill-whom=main", "--signal=SIGHUP", in.ID+"-server.service").Run()
	printJSON(e.stdout, res)
	return 0, nil
}

// systemdRunDir exists when systemd is PID 1; tests point it elsewhere.
var systemdRunDir = "/run/systemd/system"

// setPropertyCalls are the systemctl argument lists for a plan: the launcher unit holds every turn (memory = turn
// budget, tasks = every turn's pids.max + codex-login + the launcher itself), the server unit the reserve and the
// converters.
func setPropertyCalls(id string, l plan.Limits) [][]string {
	tasks := (l.MaxConcurrency+1)*l.TurnPidsMax + 64
	return [][]string{
		{"set-property", id + "-launcher.service", fmt.Sprintf("MemoryMax=%dM", l.LauncherMemoryMaxMiB), fmt.Sprintf("TasksMax=%d", tasks)},
		{"set-property", id + "-server.service", fmt.Sprintf("MemoryMax=%dM", l.ServerMemoryMaxMiB), fmt.Sprintf("MemoryHigh=%dM", l.ServerMemoryHighMiB)},
	}
}
