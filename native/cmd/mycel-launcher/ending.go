// An orderly stop of the launcher (QA TC-338): the turns that run then end with a confirmed exit that says why, never
// a broken connection.
//
//	{"op":"prepare-stop","reason":"update"} -> {"ev":"prepared","ended":N}
//
// Before, `systemctl restart <id>-launcher` (mycel-ctl update) and a launchd stop ended the launcher with every engine
// at once: the server read only a broken socket, so each answer said the AI engine stopped unexpectedly and its turn
// slot stayed quarantined (termination unconfirmed) until the app switch restarted the server.
//
// Now SIGTERM / SIGINT end every live turn first (SIGTERM to its process group, SIGKILL after 5 s, as a kill does) and
// each reports {"ev":"exit",…,"signal":"shutdown"} before the launcher exits. An update says so beforehand with
// prepare-stop (mycel-ctl, as the server account like the status request): the turns end at once with
// "signal":"update", and a stop in the next two minutes reports "update" too. A turn whose engine ended on its own is
// reported as it ended; only a turn this stop ended (or an engine killed by a signal meanwhile, systemd's
// KillMode=control-group sends SIGTERM to the engines too) gets the reason.
package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// prepareFor is how long a prepare-stop's reason holds for the stop that follows (the update restarts the launcher
// right after it asked)
const prepareFor = 2 * time.Minute

// endWait bounds how long a stop waits for the turns to report their exit (a kill takes 5 s at most, the unit's
// TimeoutStopSec is 10 s)
const endWait = 8 * time.Second

type liveTurn struct {
	stop func()
	// the reason an orderly stop ended this turn for ("" none)
	reason string
}

type turnSet struct {
	mu   sync.Mutex
	next int
	m    map[int]*liveTurn
	wg   sync.WaitGroup
	// a prepared reason for a stop until prepUntil
	prepared  string
	prepUntil time.Time
	// the launcher is stopping (SIGTERM / SIGINT) for this reason: no turn starts, and an engine a signal killed
	// meanwhile ended for it too ("" not stopping)
	closing string
}

var turns = &turnSet{m: map[int]*liveTurn{}}

// add registers a live turn's stop. "" and its id: it may run; else the reason the launcher is stopping for (the turn
// must not start).
func (t *turnSet) add(stop func()) (int, string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closing != "" {
		return 0, t.closing
	}
	t.next++
	t.m[t.next] = &liveTurn{stop: stop}
	t.wg.Add(1)
	return t.next, ""
}

func (t *turnSet) done(id int) {
	t.mu.Lock()
	_, ok := t.m[id]
	delete(t.m, id)
	t.mu.Unlock()
	if ok {
		t.wg.Done()
	}
}

// endAll ends every live turn for reason and waits (at most endWait) until each has reported its exit. closing: the
// launcher stops (no new turn starts). The number of turns it ended.
func (t *turnSet) endAll(reason string, closing bool) int {
	t.mu.Lock()
	if closing {
		t.closing = reason
	}
	stops := make([]func(), 0, len(t.m))
	for _, lt := range t.m {
		if lt.reason == "" {
			lt.reason = reason
		}
		stops = append(stops, lt.stop)
	}
	t.mu.Unlock()
	for _, s := range stops {
		s()
	}
	ended := make(chan struct{})
	go func() { t.wg.Wait(); close(ended) }()
	select {
	case <-ended:
	case <-time.After(endWait):
	}
	return len(stops)
}

// prepare remembers reason for a stop in the next prepareFor
func (t *turnSet) prepare(reason string, now time.Time) {
	t.mu.Lock()
	t.prepared, t.prepUntil = reason, now.Add(prepareFor)
	t.mu.Unlock()
}

// stopReason: what a stop now says (the prepared reason while it holds, else "shutdown")
func (t *turnSet) stopReason(now time.Time) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.prepared != "" && now.Before(t.prepUntil) {
		return t.prepared
	}
	return "shutdown"
}

// exitSignal is the "signal" of turn id's exit event: an orderly stop's reason for a turn it ended (its stop ran:
// "stopped") or whose engine a signal killed while the launcher was stopping; otherwise what the turn had.
func (t *turnSet) exitSignal(id int, sig string, werr error) string {
	t.mu.Lock()
	r, closing := "", t.closing
	if lt := t.m[id]; lt != nil {
		r = lt.reason
	}
	t.mu.Unlock()
	if r != "" && sig == "stopped" {
		return r
	}
	if sig == "" || sig == "stopped" {
		if r == "" {
			r = closing
		}
		if r != "" && signaled(werr) {
			return r
		}
	}
	return sig
}

func signaled(werr error) bool {
	if ee, ok := werr.(*exec.ExitError); ok {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return true
		}
	}
	return false
}

// validReason: the reasons a prepare-stop may give
func validReason(r string) bool { return r == "update" || r == "shutdown" }

// prepareStop answers {"op":"prepare-stop","reason":…}: the live turns end now with that reason, and a stop of the
// launcher in the next two minutes says it too.
func prepareStop(line []byte, o *out) {
	var req struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(line, &req)
	if !validReason(req.Reason) {
		o.send(map[string]any{"ev": "error", "message": "bad reason"})
		return
	}
	turns.prepare(req.Reason, time.Now())
	n := turns.endAll(req.Reason, false)
	o.send(map[string]any{"ev": "prepared", "ended": n})
}

// endOnSignal: SIGTERM / SIGINT end every turn with the stop's reason, then the launcher exits (stopAllAndExit takes
// whatever is left).
func endOnSignal() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-ch
		turns.endAll(turns.stopReason(time.Now()), true)
		stopAllAndExit()
	}()
}
