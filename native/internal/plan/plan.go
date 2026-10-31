// Package plan reads <base>/root/plan.json (linux-runtime spec 3.8.5, D18, D23) and computes the resource limits the
// launcher (turn cgroups, concurrent turns), the server (converter cgroup) and mycel-ctl apply-plan (unit MemoryMax)
// use. The file is root-owned (only `mycel-ctl apply-plan` writes it): the server account cannot raise its own limits.
// Without the file (self-install) the defaults follow the machine's memory.
package plan

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Plan is the file's shape. Pointer fields are optional ("null" = computed).
type Plan struct {
	Format                   int    `json:"format"`
	Plan                     string `json:"plan"`
	MaxConcurrency           int    `json:"maxConcurrency"`
	MemoryMiB                int    `json:"memoryMiB"`
	CPUCores                 int    `json:"cpuCores"`
	DiskGiB                  int    `json:"diskGiB"`
	ReserveMiB               int    `json:"reserveMiB"`
	TurnMemoryMaxMiB         *int   `json:"turnMemoryMaxMiB"`
	TurnPidsMax              int    `json:"turnPidsMax"`
	TurnDiskMaxMiB           int    `json:"turnDiskMaxMiB"`
	ReadMaxMiB               int    `json:"readMaxMiB"`
	ConvMemoryMaxMiB         *int   `json:"convMemoryMaxMiB"`
	LocalBackupRetentionDays int    `json:"localBackupRetentionDays"`
	// CodeSandbox: the plan lets an admin turn on the code sandbox (docs/DECISIONS.md "Code sandbox"). A plan file
	// without the field means no: the hosted service writes it for the plans that include it.
	CodeSandbox *bool  `json:"codeSandbox"`
	UpdatedAt   string `json:"updatedAt"`
	// The control plane's additions (shared/src/cloud-protocol/files.ts PlanFile, control-plane 3.5.6): the server
	// reads them (seats, the admin's plan card); the runtime only checks their shape.
	MaxActiveMembers *int            `json:"maxActiveMembers"`
	Display          json.RawMessage `json:"display"`
	Links            json.RawMessage `json:"links"`
}

// MaxFileBytes caps plan.json.
const MaxFileBytes = 64 << 10

func rng(name string, v, lo, hi int) error {
	if v < lo || v > hi {
		return fmt.Errorf("plan.json: %s %d is outside %d-%d", name, v, lo, hi)
	}
	return nil
}

// Parse checks the file's contents (spec 3.8.5 ranges) and fills defaults for omitted optional numbers.
func Parse(b []byte) (*Plan, error) {
	if len(b) > MaxFileBytes {
		return nil, fmt.Errorf("plan.json: too large")
	}
	var p Plan
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("plan.json: %v", err)
	}
	if p.Format != 1 {
		return nil, fmt.Errorf("plan.json: format must be 1")
	}
	if len(p.Plan) == 0 || len(p.Plan) > 32 {
		return nil, fmt.Errorf("plan.json: plan name must be 1-32 characters")
	}
	for _, c := range p.Plan {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return nil, fmt.Errorf("plan.json: plan name has a character other than letters, digits, - _ .")
		}
	}
	if p.ReserveMiB == 0 {
		p.ReserveMiB = 768
	}
	if p.TurnPidsMax == 0 {
		p.TurnPidsMax = 256
	}
	if p.TurnDiskMaxMiB == 0 {
		p.TurnDiskMaxMiB = 1024
	}
	if p.ReadMaxMiB == 0 {
		p.ReadMaxMiB = 200
	}
	if p.LocalBackupRetentionDays == 0 {
		p.LocalBackupRetentionDays = 14
	}
	for _, e := range []error{
		rng("maxConcurrency", p.MaxConcurrency, 1, 16),
		rng("memoryMiB", p.MemoryMiB, 1024, 262144),
		rng("cpuCores", p.CPUCores, 1, 64),
		rng("diskGiB", p.DiskGiB, 5, 10000),
		rng("reserveMiB", p.ReserveMiB, 256, 4096),
		rng("turnPidsMax", p.TurnPidsMax, 64, 4096),
		rng("turnDiskMaxMiB", p.TurnDiskMaxMiB, 128, 10240),
		rng("readMaxMiB", p.ReadMaxMiB, 8, 200),
		rng("localBackupRetentionDays", p.LocalBackupRetentionDays, 1, 30),
	} {
		if e != nil {
			return nil, e
		}
	}
	if p.ReserveMiB >= p.MemoryMiB-256 {
		return nil, fmt.Errorf("plan.json: reserveMiB leaves less than 256 MiB for turns")
	}
	if p.TurnMemoryMaxMiB != nil {
		if err := rng("turnMemoryMaxMiB", *p.TurnMemoryMaxMiB, 256, 65536); err != nil {
			return nil, err
		}
	}
	if p.ConvMemoryMaxMiB != nil {
		if err := rng("convMemoryMaxMiB", *p.ConvMemoryMaxMiB, 256, 65536); err != nil {
			return nil, err
		}
	}
	if p.MaxActiveMembers != nil {
		if err := rng("maxActiveMembers", *p.MaxActiveMembers, 1, 10000); err != nil {
			return nil, err
		}
	}
	for name, raw := range map[string]json.RawMessage{"display": p.Display, "links": p.Links} {
		if t := strings.TrimSpace(string(raw)); t != "" && t != "null" && !strings.HasPrefix(t, "{") {
			return nil, fmt.Errorf("plan.json: %s must be an object or null", name)
		}
	}
	if p.UpdatedAt != "" {
		if _, err := time.Parse(time.RFC3339, p.UpdatedAt); err != nil {
			return nil, fmt.Errorf("plan.json: updatedAt is not an RFC 3339 time")
		}
	}
	return &p, nil
}

// Limits are the numbers the runtime applies (MiB unless noted).
type Limits struct {
	FromPlan       bool   `json:"fromPlan"`
	Plan           string `json:"plan"`
	MaxConcurrency int    `json:"maxConcurrency"`
	MemoryMiB      int    `json:"memoryMiB"`
	CPUCores       int    `json:"cpuCores"`
	TurnBudgetMiB  int    `json:"turnBudgetMiB"`  // all turns together (launcher unit MemoryMax, cgroup turns/ memory.max)
	TurnMaxMiB     int    `json:"turnMaxMiB"`     // one turn memory.max
	TurnHighMiB    int    `json:"turnHighMiB"`    // one turn memory.high
	TurnPidsMax    int    `json:"turnPidsMax"`    // one turn pids.max
	TurnDiskMaxMiB int    `json:"turnDiskMaxMiB"` // chat folder size while a turn runs
	ConvMiB        int    `json:"convMiB"`        // converters together (server cgroup conv/)
	ReserveMiB     int    `json:"reserveMiB"`
	ReadMaxMiB     int    `json:"readMaxMiB"`
	// systemd unit values; 0 = do not set (self-install without a plan)
	LauncherMemoryMaxMiB int `json:"launcherMemoryMaxMiB"`
	ServerMemoryMaxMiB   int `json:"serverMemoryMaxMiB"`
	ServerMemoryHighMiB  int `json:"serverMemoryHighMiB"`
	LocalBackupRetention int `json:"localBackupRetentionDays"`
	// CodeSandbox: code runs (the launcher's "code" op) are allowed. Without a plan file (self-install): yes.
	CodeSandbox bool `json:"codeSandbox"`
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// TurnCPUMax is cpu.max for one turn ("<quota> <period>"): at most 2 cores.
func (l Limits) TurnCPUMax() string {
	c := l.CPUCores
	if c > 2 {
		c = 2
	}
	if c < 1 {
		c = 1
	}
	return fmt.Sprintf("%d 100000", c*100000)
}

// Compute turns a plan into limits (spec 3.8.5 table: Basic 2048/2 -> 800/680/512, Team 4096/3 -> 1387/1178/1024,
// Pro 8192/6 -> 1536/1305/1536).
func Compute(p *Plan) Limits {
	budget := p.MemoryMiB - p.ReserveMiB
	turnMax := clamp(int(math.Round(float64(budget)/float64(p.MaxConcurrency)*1.25)), 512, 1536)
	if p.TurnMemoryMaxMiB != nil {
		turnMax = *p.TurnMemoryMaxMiB
	}
	conv := clamp(int(math.Round(float64(p.MemoryMiB)*0.25)), 512, 1536)
	if p.ConvMemoryMaxMiB != nil {
		conv = *p.ConvMemoryMaxMiB
	}
	return Limits{
		FromPlan: true, Plan: p.Plan, MaxConcurrency: p.MaxConcurrency, MemoryMiB: p.MemoryMiB, CPUCores: p.CPUCores,
		TurnBudgetMiB: budget, TurnMaxMiB: turnMax, TurnHighMiB: int(math.Floor(float64(turnMax) * 0.85)),
		TurnPidsMax: p.TurnPidsMax, TurnDiskMaxMiB: p.TurnDiskMaxMiB, ConvMiB: conv, ReserveMiB: p.ReserveMiB,
		ReadMaxMiB: p.ReadMaxMiB, LauncherMemoryMaxMiB: budget, ServerMemoryMaxMiB: p.ReserveMiB + conv,
		ServerMemoryHighMiB: p.ReserveMiB + int(math.Floor(float64(conv)*0.75)), LocalBackupRetention: p.LocalBackupRetentionDays,
		CodeSandbox: p.CodeSandbox != nil && *p.CodeSandbox,
	}
}

// Defaults are the limits without a plan file (self-install): the machine's (or container's) memory, turn cap
// clamp(budget/2, 512, 2048), 16 concurrent turns, no unit MemoryMax.
func Defaults(memMiB, cores int) Limits {
	if memMiB <= 0 {
		memMiB = 4096
	}
	if cores <= 0 {
		cores = 1
	}
	reserve := 768
	budget := memMiB - reserve
	if budget < 512 {
		budget = 512
	}
	turnMax := clamp(budget/2, 512, 2048)
	conv := clamp(int(math.Round(float64(memMiB)*0.25)), 512, 1536)
	return Limits{
		Plan: "", MaxConcurrency: 16, MemoryMiB: memMiB, CPUCores: cores, TurnBudgetMiB: budget, TurnMaxMiB: turnMax,
		TurnHighMiB: int(math.Floor(float64(turnMax) * 0.85)), TurnPidsMax: 256, TurnDiskMaxMiB: 1024, ConvMiB: conv,
		ReserveMiB: reserve, ReadMaxMiB: 200, LocalBackupRetention: 14, CodeSandbox: true,
	}
}

// MachineMemoryMiB is the memory this tenant may use: the cgroup root's memory.max when it is a number (a container),
// else MemTotal from /proc/meminfo. 0 when unknown.
func MachineMemoryMiB() int {
	if b, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		if v, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil && v > 0 {
			return int(v >> 20)
		}
	}
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fs := strings.Fields(s.Text())
		if len(fs) >= 2 && fs[0] == "MemTotal:" {
			kb, _ := strconv.ParseInt(fs[1], 10, 64)
			return int(kb >> 10)
		}
	}
	return 0
}

// Load reads the plan file. A missing file gives the machine defaults (ok=false); any other problem is an error (the
// caller fails closed: a broken plan file must not mean "no limits").
func Load(path string) (Limits, bool, error) {
	b, err := readSmall(path)
	if os.IsNotExist(err) {
		return Defaults(MachineMemoryMiB(), runtime.NumCPU()), false, nil
	}
	if err != nil {
		return Limits{}, false, err
	}
	p, err := Parse(b)
	if err != nil {
		return Limits{}, false, err
	}
	return Compute(p), true, nil
}

func readSmall(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > MaxFileBytes {
		return nil, fmt.Errorf("%s is not a small regular file", path)
	}
	b := make([]byte, st.Size())
	_, err = io.ReadFull(f, b)
	return b, err
}

// Cache re-reads a plan file when its modification time changes (the launcher asks before every turn).
type Cache struct {
	Path  string
	mtime time.Time
	size  int64
	l     Limits
	ok    bool
	err   error
	init  bool
}

// Get returns the current limits (re-read only after a change).
func (c *Cache) Get() (Limits, bool, error) {
	st, err := os.Stat(c.Path)
	if err != nil {
		if os.IsNotExist(err) {
			if !c.init || c.ok || c.err != nil || !c.mtime.IsZero() {
				c.l, c.ok, c.err = Load(c.Path)
				c.mtime, c.size, c.init = time.Time{}, 0, true
			}
			return c.l, c.ok, c.err
		}
		return Limits{}, false, err
	}
	if !c.init || !st.ModTime().Equal(c.mtime) || st.Size() != c.size {
		c.l, c.ok, c.err = Load(c.Path)
		c.mtime, c.size, c.init = st.ModTime(), st.Size(), true
	}
	return c.l, c.ok, c.err
}
