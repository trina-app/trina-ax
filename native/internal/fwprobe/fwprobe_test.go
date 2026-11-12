package fwprobe

import (
	"net"
	"strings"
	"testing"
	"time"
)

// Without the engine firewall (a test machine, a flushed ruleset) a loopback connection goes through: Probe fails.
func TestProbeFailsWithoutFirewall(t *testing.T) {
	err := Probe(1, time.Second)
	if err == nil {
		t.Fatal("Probe passed on a machine without the engine firewall")
	}
	if !strings.Contains(err.Error(), "loopback") || !strings.Contains(err.Error(), "went through") {
		t.Fatalf("unexpected reason: %v", err)
	}
}

func TestExpectRefused(t *testing.T) {
	// a closed loopback port answers with a reset, like the firewall: refused
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	if err := expectRefused(addr, time.Second, false); err != nil {
		t.Fatalf("closed port: %v", err)
	}
	// an open one goes through
	ln, err = net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := expectRefused(ln.Addr().String(), time.Second, false); err == nil || !strings.Contains(err.Error(), "went through") {
		t.Fatalf("open port: %v", err)
	}
}
