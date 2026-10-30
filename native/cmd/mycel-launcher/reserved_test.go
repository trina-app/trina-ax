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
