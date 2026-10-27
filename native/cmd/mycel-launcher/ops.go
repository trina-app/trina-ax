// Launcher requests besides turns (linux-runtime spec 3.3.2, 3.8.10; both platforms), only from the server uid:
//
//	{"op":"status"}                 -> {"ev":"status","os":…,"sandbox":…,"liveTurns":N,…}  (diagnostics)
//	{"op":"forget","chatId":"<id>"} -> {"ev":"forgot","ok":true}  deletes <agent root>/<chatId>
//
// forget exists because the server cannot delete a chat's engine folder itself: it belongs to the engine account
// (700), so permanently deleted chats left their folders behind (server/src/auth/sweeper.ts, chat/runtime.ts
// purgeChat; the same on macOS). The daily sweep removes chat folders nobody used for 30 days (the sessions live on
// the server, a later turn starts the folder again).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func statusEvent() map[string]any {
	ev := map[string]any{"ev": "status", "liveTurns": liveTurnCount(), "dedicated": *dedicated}
	platformStatus(ev)
	return ev
}

// chatFolder returns <agent root>/<id> for a valid chat id that is not a reserved name.
func chatFolder(id string) (string, error) {
	if !chatIDRe.MatchString(id) || reservedAgentNames[id] {
		return "", fmt.Errorf("bad chat id")
	}
	p := filepath.Join(filepath.Clean(*agentRoot), id)
	if isCodexAuthDir(p) {
		return "", fmt.Errorf("bad chat id")
	}
	return p, nil
}

func forgetChat(line []byte, o *out) {
	var req struct {
		ChatID string `json:"chatId"`
	}
	if err := json.Unmarshal(line, &req); err != nil {
		o.send(map[string]any{"ev": "error", "message": "bad request"})
		return
	}
	p, err := chatFolder(req.ChatID)
	if err != nil {
		o.send(map[string]any{"ev": "error", "message": err.Error()})
		return
	}
	if chatBusy(p) {
		o.send(map[string]any{"ev": "error", "message": "busy: a turn of this chat is running"})
		return
	}
	// one path component below the trusted agent root: os.RemoveAll never follows a link below it (openat-based) and
	// unlinks the folder itself if it is a link
	if err := os.RemoveAll(p); err != nil {
		o.send(map[string]any{"ev": "forgot", "ok": false, "message": err.Error()})
		return
	}
	o.send(map[string]any{"ev": "forgot", "ok": true})
}

// sweepAge: a chat folder (and its .claude) untouched this long is removed by the daily sweep.
const sweepAge = 30 * 24 * time.Hour

// sweepOnce removes stale chat folders directly under the agent root; returns how many.
func sweepOnce(now time.Time) int {
	root := filepath.Clean(*agentRoot)
	ents, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range ents {
		p, err := chatFolder(e.Name())
		if err != nil || !e.IsDir() || chatBusy(p) {
			continue
		}
		st, err := os.Lstat(p)
		if err != nil || !st.IsDir() || now.Sub(st.ModTime()) < sweepAge {
			continue
		}
		if cst, err := os.Lstat(filepath.Join(p, ".claude")); err == nil && now.Sub(cst.ModTime()) < sweepAge {
			continue
		}
		if os.RemoveAll(p) == nil {
			n++
		}
	}
	return n
}

// dailySweep runs the sweep an hour after start and then every 24 hours.
func dailySweep() {
	time.Sleep(time.Hour)
	for {
		if n := sweepOnce(time.Now()); n > 0 {
			fmt.Fprintf(os.Stderr, "mycel-launcher: removed %d chat folders unused for 30 days\n", n)
		}
		time.Sleep(24 * time.Hour)
	}
}
