package plan

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestComputeTable(t *testing.T) {
	// spec 3.8.5 table
	for _, c := range []struct{ mem, conc, max, high, conv, budget int }{
		{2048, 2, 800, 680, 512, 1280},
		{4096, 3, 1387, 1178, 1024, 3328},
		{8192, 6, 1536, 1305, 1536, 7424},
	} {
		p, err := Parse([]byte(`{"format":1,"plan":"x","maxConcurrency":` + itoa(c.conc) + `,"memoryMiB":` + itoa(c.mem) + `,"cpuCores":2,"diskGiB":20,"reserveMiB":768,"turnMemoryMaxMiB":null,"turnPidsMax":256,"turnDiskMaxMiB":1024,"readMaxMiB":128,"convMemoryMaxMiB":null,"localBackupRetentionDays":3,"updatedAt":"2026-10-22T00:00:00Z"}`))
		if err != nil {
			t.Fatal(err)
		}
		l := Compute(p)
		if l.TurnMaxMiB != c.max || l.TurnHighMiB != c.high || l.ConvMiB != c.conv || l.TurnBudgetMiB != c.budget {
			t.Errorf("%d/%d: got %+v", c.mem, c.conc, l)
		}
		if l.LauncherMemoryMaxMiB != c.budget || l.ServerMemoryMaxMiB != 768+c.conv {
			t.Errorf("unit values %+v", l)
		}
		if l.TurnCPUMax() != "200000 100000" {
			t.Errorf("cpu.max %s", l.TurnCPUMax())
		}
	}
}

func itoa(i int) string { return strconv.Itoa(i) }

func TestParseRejects(t *testing.T) {
	for _, b := range []string{
		`{"format":2,"plan":"x","maxConcurrency":2,"memoryMiB":2048,"cpuCores":1,"diskGiB":20}`,
		`{"format":1,"plan":"x","maxConcurrency":0,"memoryMiB":2048,"cpuCores":1,"diskGiB":20}`,
		`{"format":1,"plan":"x","maxConcurrency":17,"memoryMiB":2048,"cpuCores":1,"diskGiB":20}`,
		`{"format":1,"plan":"x","maxConcurrency":2,"memoryMiB":512,"cpuCores":1,"diskGiB":20}`,
		`{"format":1,"plan":"x","maxConcurrency":2,"memoryMiB":2048,"cpuCores":1,"diskGiB":20,"readMaxMiB":500}`,
		`{"format":1,"plan":"x y","maxConcurrency":2,"memoryMiB":2048,"cpuCores":1,"diskGiB":20}`,
		`{"format":1,"plan":"x","maxConcurrency":2,"memoryMiB":2048,"cpuCores":1,"diskGiB":20,"unknown":1}`,
		`{"format":1,"plan":"x","maxConcurrency":2,"memoryMiB":1024,"cpuCores":1,"diskGiB":20,"reserveMiB":900}`,
		`not json`,
	} {
		if _, err := Parse([]byte(b)); err == nil {
			t.Errorf("accepted %s", b)
		}
	}
}

func TestDefaultsAndCache(t *testing.T) {
	l := Defaults(8192, 4)
	if l.MaxConcurrency != 16 || l.TurnMaxMiB != 2048 || l.LauncherMemoryMaxMiB != 0 || l.FromPlan {
		t.Errorf("defaults %+v", l)
	}
	if Defaults(2048, 1).TurnMaxMiB != 640 {
		t.Errorf("small machine %+v", Defaults(2048, 1))
	}
	dir := t.TempDir()
	c := &Cache{Path: filepath.Join(dir, "plan.json")}
	if _, ok, err := c.Get(); ok || err != nil {
		t.Fatalf("missing file: ok=%v err=%v", ok, err)
	}
	os.WriteFile(c.Path, []byte(`{"format":1,"plan":"basic","maxConcurrency":2,"memoryMiB":2048,"cpuCores":1,"diskGiB":20}`), 0o644)
	l2, ok, err := c.Get()
	if !ok || err != nil || l2.MaxConcurrency != 2 || l2.TurnMaxMiB != 800 {
		t.Fatalf("plan: %+v %v %v", l2, ok, err)
	}
	os.WriteFile(c.Path, []byte(`{broken`), 0o644)
	if _, _, err := c.Get(); err == nil {
		t.Fatal("broken plan accepted")
	}
}

// The plan the control plane writes (shared/src/cloud-protocol PlanFile, with maxActiveMembers / display / links) is
// accepted; other unknown keys are still refused, and the additions must have their shape.
func TestControlPlaneFields(t *testing.T) {
	cp := `{"format":1,"plan":"team","maxConcurrency":3,"memoryMiB":4096,"cpuCores":3,"diskGiB":50,"reserveMiB":768,"turnMemoryMaxMiB":null,
"turnPidsMax":256,"turnDiskMaxMiB":1024,"readMaxMiB":128,"convMemoryMaxMiB":null,"localBackupRetentionDays":3,"updatedAt":"2026-10-22T00:00:00Z",
"maxActiveMembers":12,"display":{"name":{"ko":"팀","en":"Team","id":"Tim"}},"links":{"account":"https://account.treesoop.com","status":"https://status.treesoop.com","support":"support@treesoop.com"}}`
	p, err := Parse([]byte(cp))
	if err != nil || p.MaxActiveMembers == nil || *p.MaxActiveMembers != 12 || p.LocalBackupRetentionDays != 3 {
		t.Fatalf("control plane plan: %v %+v", err, p)
	}
	for _, bad := range []string{
		strings.Replace(cp, `"maxActiveMembers":12`, `"maxActiveMembers":0`, 1),
		strings.Replace(cp, `"links":{`, `"links":"x","x":{`, 1),
		strings.Replace(cp, `"format":1,`, `"format":1,"surprise":true,`, 1),
	} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Fatalf("accepted %s", bad[:80])
		}
	}
	if _, err := Parse([]byte(strings.Replace(cp, `"maxActiveMembers":12,"display":{"name":{"ko":"팀","en":"Team","id":"Tim"}}`, `"maxActiveMembers":null,"display":null`, 1))); err != nil {
		t.Fatal(err)
	}
}

// speechFreeHours (the hosting service's free speech-to-text hours a month): absent or null is the server's default,
// whole hours 1-1000 are accepted, as by shared/src/cloud-protocol PlanFile.
func TestSpeechFreeHours(t *testing.T) {
	base := `{"format":1,"plan":"team","maxConcurrency":3,"memoryMiB":4096,"cpuCores":3,"diskGiB":50`
	p, err := Parse([]byte(base + `}`))
	if err != nil || p.SpeechFreeHours != nil {
		t.Fatalf("absent: %v %+v", err, p)
	}
	if p, err = Parse([]byte(base + `,"speechFreeHours":null}`)); err != nil || p.SpeechFreeHours != nil {
		t.Fatalf("null: %v %+v", err, p)
	}
	for _, h := range []int{1, 50, 100, 200, 1000} {
		p, err := Parse([]byte(base + `,"speechFreeHours":` + itoa(h) + `}`))
		if err != nil || p.SpeechFreeHours == nil || *p.SpeechFreeHours != h {
			t.Fatalf("%d: %v %+v", h, err, p)
		}
	}
	for _, bad := range []string{`0`, `-1`, `1001`, `1.5`, `"50"`, `true`} {
		if _, err := Parse([]byte(base + `,"speechFreeHours":` + bad + `}`)); err == nil {
			t.Errorf("accepted speechFreeHours %s", bad)
		}
	}
}

// The contract's vectors (shared/src/cloud-protocol/vectors/vectors.json): every plan.json the control plane may send
// (apply-plan's stdin, the enroll answer's plan) parses here, and a plan the contract refuses is refused here too.
func TestContractVectors(t *testing.T) {
	b, err := os.ReadFile("../../../shared/src/cloud-protocol/vectors/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	type cmd struct {
		Command string          `json:"command"`
		Stdin   json.RawMessage `json:"stdin"`
		Why     string          `json:"why"`
	}
	var v struct {
		TenantCommands struct {
			Allowed []cmd `json:"allowed"`
			Refused []cmd `json:"refused"`
		} `json:"tenantCommands"`
		Enroll struct {
			Plan json.RawMessage `json:"plan"`
		} `json:"enroll"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(v.Enroll.Plan); err != nil {
		t.Fatalf("enroll plan: %v", err)
	}
	n := 0
	for _, c := range v.TenantCommands.Allowed {
		if c.Command == "apply-plan" {
			n++
			if _, err := Parse(c.Stdin); err != nil {
				t.Errorf("allowed plan refused: %v", err)
			}
		}
	}
	for _, c := range v.TenantCommands.Refused {
		if c.Command == "apply-plan" && c.Why == "stdin schema" {
			n++
			if _, err := Parse(c.Stdin); err == nil {
				t.Errorf("refused plan accepted: %s", c.Stdin)
			}
		}
	}
	if n < 4 {
		t.Fatalf("only %d plan vectors", n)
	}
}
