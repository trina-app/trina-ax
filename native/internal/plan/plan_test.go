package plan

import (
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
