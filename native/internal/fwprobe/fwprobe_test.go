package fwprobe

import (
	"net"
	"os"
	"strings"
	"syscall"
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

// A blackhole / prohibit / unreachable route to a remote target answers at connect(), before the output hook: with the
// table loaded that is still "nothing left the machine" (review of #543). Loopback never accepts it, and a timeout or
// a connection that goes through never passes.
func TestExpectRefusedRouteErrors(t *testing.T) {
	saved := dial
	defer func() { dial = saved }()
	var answer error
	dial = func(network, addr string, timeout time.Duration) (net.Conn, error) {
		return nil, &net.OpError{Op: "dial", Net: network, Err: os.NewSyscallError("connect", answer)}
	}
	for _, e := range []syscall.Errno{syscall.ECONNREFUSED, syscall.ENETUNREACH, syscall.EHOSTUNREACH, syscall.EACCES, syscall.EPERM, syscall.EINVAL} {
		answer = e
		if err := expectRefused("169.254.169.254:80", time.Second, true); err != nil {
			t.Fatalf("remote %v: %v", e, err)
		}
		if e != syscall.ECONNREFUSED {
			if err := expectRefused("127.0.0.1:9", time.Second, false); err == nil {
				t.Fatalf("loopback accepted %v", e)
			}
		}
	}
	answer = syscall.ECONNRESET
	if err := expectRefused("192.0.2.1:443", time.Second, true); err == nil {
		t.Fatal("ECONNRESET accepted")
	}
	dial = func(string, string, time.Duration) (net.Conn, error) { return nil, timeoutErr{} }
	if err := expectRefused("192.0.2.1:443", time.Second, true); err == nil {
		t.Fatal("a timeout passed")
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }
