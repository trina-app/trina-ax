package main

import (
	"sync"
	"testing"
	"time"
)

// A prepare-stop ends the turns that run and waits only for those; turns are refused while it holds, and a turn the
// server had already stopped keeps its own end (QA TC-338).
func TestTurnSetEndAllWaitsOnlyForItsTurns(t *testing.T) {
	ts := &turnSet{m: map[int]*liveTurn{}}
	now := time.Now()
	var mu sync.Mutex
	stopped := map[int]bool{}
	reg := func(fired bool) int {
		var id int
		id, r := ts.add(func() {
			mu.Lock()
			stopped[id] = true
			mu.Unlock()
		}, func() bool { return fired }, now)
		if r != "" {
			t.Fatalf("refused: %s", r)
		}
		return id
	}
	a, b := reg(false), reg(true)
	go func() {
		time.Sleep(50 * time.Millisecond)
		if got := ts.exitSignal(a, "stopped", -1, nil); got != "update" {
			t.Errorf("a: %q", got)
		}
		if got := ts.exitSignal(b, "stopped", -1, nil); got != "stopped" {
			t.Errorf("b (the server's own stop): %q", got)
		}
		ts.done(a)
		ts.done(b)
	}()
	ts.prepare("update", now)
	n, all := ts.endAll("update", false)
	if n != 2 || !all {
		t.Fatalf("%d %v", n, all)
	}
	if _, r := ts.add(func() {}, nil, now.Add(time.Minute)); r != "update" {
		t.Fatalf("a new turn while the prepare holds: %q", r)
	}
	if ts.stopping(now.Add(3*time.Minute)) != "" {
		t.Fatal("the prepare holds two minutes only")
	}
	c, r := ts.add(func() {}, nil, now.Add(3*time.Minute))
	if r != "" || ts.exitSignal(c, "", 0, nil) != "" {
		t.Fatalf("a turn after it: %q", r)
	}
	ts.done(c)
}

// Turns that start and end while endAll waits never panic or hold it (the WaitGroup reuse of the first version).
func TestTurnSetEndAllWithChurn(t *testing.T) {
	ts := &turnSet{m: map[int]*liveTurn{}}
	id, _ := ts.add(func() {}, nil, time.Now())
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if i, r := ts.add(func() {}, nil, time.Now()); r == "" {
				ts.done(i)
			}
		}
	}()
	go func() { time.Sleep(20 * time.Millisecond); ts.done(id) }()
	if n, all := ts.endAll("shutdown", false); n < 1 || !all {
		t.Fatalf("%d %v", n, all)
	}
	close(stop)
	wg.Wait()
	// closing: refused from now on
	ts.endAll("shutdown", true)
	if _, r := ts.add(func() {}, nil, time.Now()); r != "shutdown" {
		t.Fatalf("%q", r)
	}
}
