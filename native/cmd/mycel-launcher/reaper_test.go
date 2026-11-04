package main

import (
	"reflect"
	"testing"

	"mycel/native/internal/peer"
)

// G-EC2-6: the reaper kills an orphan of the engine account (ppid 1, for example a systemd-run unit with
// User=axagent) whatever its size, and keeps the launcher, its parent, its session, live turns and non-orphans.
func TestStrays(t *testing.T) {
	const me, myPpid, mySid = 100, 1, 100
	liveSids := map[int]bool{200: true}
	ps := []peer.Proc{
		{Pid: 100, Ppid: 1, Sid: 100},   // the launcher (started by systemd)
		{Pid: 101, Ppid: 100, Sid: 100}, // in the launcher's session
		{Pid: 200, Ppid: 100, Sid: 200}, // engine of a live turn
		{Pid: 201, Ppid: 1, Sid: 200},   // orphan inside a live turn session
		{Pid: 300, Ppid: 1, Sid: 300},   // systemd-run -p User=axagent: killed
		{Pid: 301, Ppid: 1, Sid: 250},   // setsid escapee of an ended turn: killed
		{Pid: 400, Ppid: 350, Sid: 400}, // runuser child: parent alive, kept
	}
	got := strays(ps, me, myPpid, mySid, func(s int) bool { return liveSids[s] })
	want := []peer.Proc{{Pid: 300, Ppid: 1, Sid: 300}, {Pid: 301, Ppid: 1, Sid: 250}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("strays = %v, want %v", got, want)
	}
}

func TestProcCommMissing(t *testing.T) {
	if c := procComm(-1); c != "" {
		t.Fatalf("procComm(-1) = %q, want empty", c)
	}
}
