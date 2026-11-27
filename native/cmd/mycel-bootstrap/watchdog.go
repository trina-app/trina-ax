// The watchdog: a server that runs but stops answering /api/health (a hung event loop, a stuck database lock) is
// stopped and started again, like a crash (docs/decisions/20261127-restart.md).
//
//   - It looks only at a version that runs normally: a pending update and a forwarded version keep their own watch
//     (health timeout, attempts, roll-back), and exit 75 / block() are unchanged.
//   - It counts only after this start answered health ok once: a restore applied at start, or migrations before the
//     server listens, are never a hang. A 503 "migrating" answer is an answer.
//   - Every watchEvery (30 s) the same checkHealth as the update watch (3 s timeout); watchFailures (10) failures in a
//     row, about 5 minutes, is a hang. Slow work is not killed.
//   - Kill switch: server.json {"watchdog": {"kill": true}} (read at every hang, so it can be turned on without a
//     restart). Off by default: the hang is logged only, so QA can watch the log before it kills.
//   - At most watchMaxKills (3) kills in watchKillWindow (an hour). Then it gives up: state.json liveness {gaveUp,
//     since, detail} (mycel-ctl status, Admin › System › Health) until the next healthy answer, never reset by the
//     clock: a server that can never answer again would otherwise be cut every hour.
//
// Watchdog kills are not restarts people asked for: the server's restart limit does not count them.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"
)

// tunables (tests make them short)
var (
	watchEvery      = 30 * time.Second
	watchFailures   = 10
	watchMaxKills   = 3
	watchKillWindow = time.Hour
)

// errWatchdog is the "exit" of a server the watchdog stopped (the crash path restarts it)
var errWatchdog = errors.New("stopped by the watchdog: it did not answer health")

type livenessState struct {
	GaveUp bool   `json:"gaveUp"`
	Since  string `json:"since"`
	Detail string `json:"detail"`
}

func gaveUpBefore(st appState) bool { return st.Liveness != nil && st.Liveness.GaveUp }

type watchdog struct {
	// armed: this start of the server answered health ok once
	armed bool
	// failures in a row since the last answer
	fails int
	// the hang was logged in log-only mode (once per hang)
	logged bool
	// when it stopped the server, over all starts
	kills  []time.Time
	gaveUp bool
}

// started: a new start of the server; it is watched once it answers
func (w *watchdog) started() { w.armed, w.fails, w.logged = false, 0, false }

// answered: the server answered health ok (also the update watch's ok)
func (w *watchdog) answered() {
	w.armed, w.fails, w.logged = true, 0, false
	if w.gaveUp {
		w.gaveUp = false
		st := readState()
		if st.Liveness != nil {
			st.Liveness = nil
			_ = writeState(st)
		}
		logf("watchdog: the server answers again; it restarts a hung server again from now on")
	}
}

// killOn: server.json says watchdog.kill true
func killOn() bool {
	b, err := os.ReadFile(*configFile)
	if err != nil {
		return false
	}
	var c struct {
		Watchdog *struct {
			Kill bool `json:"kill"`
		} `json:"watchdog"`
	}
	return json.Unmarshal(b, &c) == nil && c.Watchdog != nil && c.Watchdog.Kill
}

// look takes one health answer of version v; true: stop the server now (the caller restarts it as after a crash)
func (w *watchdog) look(v string, hs healthState, now time.Time) bool {
	if hs == isHealthy {
		w.answered()
		return false
	}
	if hs == migrating {
		w.fails = 0 // it answers: busy with its database, not hung
		return false
	}
	if !w.armed {
		return false
	}
	w.fails++
	if w.fails < watchFailures {
		return false
	}
	hung := fmt.Sprintf("server %s did not answer health %d times in a row (every %v)", v, w.fails, watchEvery)
	if w.gaveUp {
		return false // waits for its next healthy answer
	}
	if !killOn() {
		if !w.logged {
			logf("watchdog: %s; not restarting it: server.json watchdog.kill is off (log only)", hung)
			w.logged = true
		}
		return false
	}
	kept := w.kills[:0]
	for _, t := range w.kills {
		if now.Sub(t) < watchKillWindow {
			kept = append(kept, t)
		}
	}
	w.kills = kept
	if len(w.kills) >= watchMaxKills {
		w.gaveUp = true
		detail := fmt.Sprintf("%s; restarted %d times within %v already, so it is left running until it answers again", hung, len(w.kills), watchKillWindow)
		st := readState()
		st.Liveness = &livenessState{GaveUp: true, Since: now.UTC().Format(time.RFC3339Nano), Detail: detail}
		if err := writeState(st); err != nil {
			logf("cannot write state.json: %v", err)
		}
		logf("watchdog: gave up: %s", detail)
		return false
	}
	w.kills = append(w.kills, now)
	w.fails = 0
	logf("watchdog: %s; restarting it (%d of %d within %v)", hung, len(w.kills), watchMaxKills, watchKillWindow)
	return true
}
