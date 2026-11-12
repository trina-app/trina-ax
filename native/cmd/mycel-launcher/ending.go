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
// reported as it ended; only a turn this stop ended (or an engine killed by a signal or ended with an error meanwhile:
// systemd's KillMode=control-group sends SIGTERM to the engines too) gets the reason.
//
// From a prepare-stop until the launcher exits (or the two minutes pass) and while it stops, a new turn is refused
// before anything of it starts: {"ev":"error","message":"launcher_stopping: <reason>"}. The server keeps such a turn
// (it never ran) and waits until a status answer has no "stopping" (the next launcher). The status says "stopping".
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

// endWait bounds how long a stop waits for the turns it ended to report their exit (a kill takes 5 s at most); a
// signal's stop then kills what is left at once: all of it inside the unit's TimeoutStopSec=10
const endWait = 6 * time.Second

type liveTurn struct {
	stop func()
	// the turn's stop already ran (the server's kill, its connection gone, the timeout): not this stop's doing
	fired func() bool
	// the reason an orderly stop ended this turn for ("" none)
	reason string
	// closed once the turn reported its end (done)
	ended chan struct{}
}

type turnSet struct {
	mu   sync.Mutex
	next int
	m    map[int]*liveTurn
	// a prepared reason for a stop until prepUntil
	prepared  string
	prepUntil time.Time
	// the launcher is stopping (SIGTERM / SIGINT) for this reason: no turn starts, and an engine that ended meanwhile
	// ended for it too ("" not stopping)
	closing string
}

var turns = &turnSet{m: map[int]*liveTurn{}}

// add registers a live turn's stop. "" and its id: it may run; else the reason the launcher is stopping for (the turn
// must not start: a prepare-stop holds, or the launcher stops).
func (t *turnSet) add(stop func(), fired func() bool, now time.Time) (int, string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if r := t.stoppingLocked(now); r != "" {
		return 0, r
	}
	t.next++
	t.m[t.next] = &liveTurn{stop: stop, fired: fired, ended: make(chan struct{})}
	return t.next, ""
}

// done: the turn reported its end
func (t *turnSet) done(id int) {
	t.mu.Lock()
	lt := t.m[id]
	delete(t.m, id)
	t.mu.Unlock()
	if lt != nil {
		close(lt.ended)
	}
}

// endAll ends every live turn for reason and waits (at most endWait) until those turns have reported their exit (a
// turn that starts meanwhile is not waited for). closing: the launcher stops. The number of turns it ended, and
// whether all of them reported in time.
func (t *turnSet) endAll(reason string, closing bool) (int, bool) {
	t.mu.Lock()
	if closing {
		t.closing = reason
	}
	var stops []func()
	var ended []chan struct{}
	for _, lt := range t.m {
		if lt.reason == "" && (lt.fired == nil || !lt.fired()) {
			lt.reason = reason
		}
		stops = append(stops, lt.stop)
		ended = append(ended, lt.ended)
	}
	t.mu.Unlock()
	for _, s := range stops {
		s()
	}
	deadline := time.After(endWait)
	for _, e := range ended {
		select {
		case <-e:
		case <-deadline:
			return len(stops), false
		}
	}
	return len(stops), true
}

// prepare remembers reason for a stop in the next prepareFor
func (t *turnSet) prepare(reason string, now time.Time) {
	t.mu.Lock()
	t.prepared, t.prepUntil = reason, now.Add(prepareFor)
	t.mu.Unlock()
}

func (t *turnSet) stoppingLocked(now time.Time) string {
	if t.closing != "" {
		return t.closing
	}
	if t.prepared != "" && now.Before(t.prepUntil) {
		return t.prepared
	}
	return ""
}

// stopping: the reason the launcher stops or is about to ("" neither), for the status answer
func (t *turnSet) stopping(now time.Time) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.stoppingLocked(now)
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
// "stopped"), or for an engine that a signal killed or that ended with an error while the launcher stops; otherwise
// what the turn had.
func (t *turnSet) exitSignal(id int, sig string, code int, werr error) string {
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
		if r != "" && (signaled(werr) || (closing != "" && code != 0)) {
			return r
		}
	}
	return sig
}

func exitCode(werr error) int {
	if ee, ok := werr.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return 0
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

// prepareStop answers {"op":"prepare-stop","reason":…}: the live turns end now with that reason, new turns are refused,
// and a stop of the launcher in the next two minutes says the reason too.
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
	n, _ := turns.endAll(req.Reason, false)
	o.send(map[string]any{"ev": "prepared", "ended": n})
}

// endOnSignal: SIGTERM / SIGINT end every turn with the stop's reason, then the launcher exits, killing at once what
// did not end in time. A second signal exits at once.
func endOnSignal() {
	ch := make(chan os.Signal, 2)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-ch
		go func() { <-ch; killAllAndExit() }()
		turns.endAll(turns.stopReason(time.Now()), true)
		killAllAndExit()
	}()
}

// killAllAndExit: SIGKILL to every live turn's process group, then exit
func killAllAndExit() {
	live.mu.Lock()
	for p := range live.m {
		_ = syscall.Kill(-p, syscall.SIGKILL)
	}
	live.mu.Unlock()
	os.Exit(0)
}
