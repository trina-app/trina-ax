package main

import "testing"

// A request's files may not replace the turn files the launcher writes itself (plan review S12).
func TestReservedTurnFiles(t *testing.T) {
	for _, rel := range []string{".turn/token", ".turn/mcp.json", ".turn/system.md", ".turn", "./.turn/token", ".turn/x/../token", ".Turn/TOKEN", ".TURN/Mcp.Json", ".turn/System.md"} {
		if !reservedTurnFile(rel) {
			t.Errorf("%s should be reserved", rel)
		}
	}
	for _, rel := range []string{".turn/agents.json", ".turn/subagent.md", ".codex/config.toml", "token", ".turn/token.bak"} {
		if reservedTurnFile(rel) {
			t.Errorf("%s should be allowed", rel)
		}
	}
}

func TestCapBuf(t *testing.T) {
	c := &capBuf{max: 4}
	_, _ = c.Write([]byte("ab"))
	_, _ = c.Write([]byte("cdef"))
	if c.text() != "abcd" || c.dropped != 2 {
		t.Fatalf("%q %d", c.text(), c.dropped)
	}
	u := &capBuf{max: 4}
	_, _ = u.Write([]byte("aé€")) // 1 + 2 + 3 bytes: the cut leaves half of the euro sign
	if u.text() != "aé" {
		t.Fatalf("cut character kept: %q", u.text())
	}
}
