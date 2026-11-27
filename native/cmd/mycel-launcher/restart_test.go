package main

import (
	"bufio"
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"
)

// {"op":"restart"} (Admin's "AI only" restart, docs/decisions/20261127-restart.md): the answer comes first, new turns are
// refused at once with the reason "restart", the live turns end with "signal":"restart", then the launcher exits.
func TestRestartOpEndsTurnsThenExits(t *testing.T) {
	old := turns
	turns = &turnSet{m: map[int]*liveTurn{}}
	exited := make(chan struct{})
	oldExit := exitAfterRestart
	exitAfterRestart = func() { close(exited) }
	defer func() { turns, exitAfterRestart = old, oldExit }()

	now := time.Now()
	var id int
	stopped := make(chan struct{})
	id, r := turns.add(func() { close(stopped) }, func() bool { return false }, now)
	if r != "" {
		t.Fatalf("refused: %s", r)
	}
	go func() { // the turn reports its end once its stop ran
		<-stopped
		if got := turns.exitSignal(id, "stopped", -1, nil); got != "restart" {
			t.Errorf("exit signal %q, want restart", got)
		}
		turns.done(id)
	}()

	sock := filepath.Join(t.TempDir(), "l.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.AcceptUnix()
		if err != nil {
			return
		}
		restartOp(&out{c: c})
	}()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var ev struct {
		Ev   string `json:"ev"`
		Live int    `json:"live"`
	}
	if json.Unmarshal(line, &ev) != nil || ev.Ev != "restarting" || ev.Live != 1 {
		t.Fatalf("answer %s", line)
	}
	if _, r := turns.add(func() {}, nil, time.Now()); r != "restart" {
		t.Fatalf("a new turn after the request: %q, want restart", r)
	}
	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		t.Fatal("the launcher did not exit after the restart")
	}
	if turns.stopping(time.Now()) != "restart" {
		t.Fatal("the status must say stopping: restart until the next launcher")
	}
}

// The status lists the op, so a server offers "AI only" only to a launcher that knows it.
func TestStatusAdvertisesRestart(t *testing.T) {
	ev := statusEvent()
	ops, _ := ev["ops"].([]string)
	found := false
	for _, o := range ops {
		found = found || o == "restart"
	}
	if !found {
		t.Fatalf("status ops %v", ev["ops"])
	}
}
