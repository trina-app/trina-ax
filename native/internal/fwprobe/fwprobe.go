// Package fwprobe checks that the engine firewall is in effect right now, as the engine account itself (QA TC-310).
//
// The status file (fwstatus) says what `mycel-ctl firewall apply` loaded at its last run; another tool can take the
// table away afterwards (`nft flush ruleset`, a ufw/firewalld or Docker reload), and the file still says "loaded" until
// it is stale. The launcher runs as the engine account without capabilities, so it cannot list nftables. It tests what
// the table does instead: the engine account's `engine_out` chain accepts 127.0.0.1:<proxy port> only and answers
// every other TCP connection with a reset, so each connection below must be refused at once. One that goes through, or
// waits for an answer, means the table is gone or changed.
package fwprobe

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Target is a connection the engine firewall must refuse.
type Target struct {
	Name string
	Addr string
}

// Remote: the cloud metadata address and a documentation address (TEST-NET-1, RFC 5737, never routed) for "the
// internet". Both are refused by the table before a packet leaves the machine.
var Remote = []Target{
	{"the cloud metadata address", "169.254.169.254:80"},
	{"a public internet address", "192.0.2.1:443"},
}

// Probe returns nil when the calling account's TCP connections are refused as the engine firewall refuses them: to a
// listener of its own on 127.0.0.1 (another port than proxyPort) and to Remote. timeout bounds each connection; the
// remote ones run at the same time.
func Probe(proxyPort int, timeout time.Duration) error {
	ln, err := listenLoopback(proxyPort)
	if err != nil {
		return fmt.Errorf("cannot open a loopback test port: %v", err)
	}
	defer ln.Close()
	if err := expectRefused(ln.Addr().String(), timeout, false); err != nil {
		return fmt.Errorf("a loopback connection to a port other than the model proxy %v", err)
	}
	// at the same time: with the table each is refused at once, without it the slowest waits timeout once
	errs := make([]error, len(Remote))
	var wg sync.WaitGroup
	for i, t := range Remote {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := expectRefused(t.Addr, timeout, true); err != nil {
				errs[i] = fmt.Errorf("a connection to %s (%s) %v", t.Name, t.Addr, err)
			}
		}()
	}
	wg.Wait()
	var msgs []string
	for _, e := range errs {
		if e != nil {
			msgs = append(msgs, e.Error())
		}
	}
	if len(msgs) > 0 {
		return errors.New(strings.Join(msgs, "; "))
	}
	return nil
}

func listenLoopback(proxyPort int) (net.Listener, error) {
	for i := 0; i < 3; i++ {
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		if ln.Addr().(*net.TCPAddr).Port != proxyPort {
			return ln, nil
		}
		ln.Close()
	}
	return nil, fmt.Errorf("the system keeps giving the model proxy's port")
}

// expectRefused: nil when the connection is refused (the table's reset). blockedOK (the remote targets) also accepts
// the errors a route answers with before the output hook runs: a blackhole, prohibit or unreachable route (common
// metadata hardening: EINVAL, EACCES, EHOSTUNREACH), no route at all (ENETUNREACH) or another tool's local drop
// (EPERM). Nothing left the machine for it, and the loopback check already proves the table's reject rule; without
// this a hardened server would refuse every turn although its table is loaded.
func expectRefused(addr string, timeout time.Duration, blockedOK bool) error {
	c, err := dial("tcp", addr, timeout)
	if err == nil {
		c.Close()
		return errors.New("went through")
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return nil
	}
	if blockedOK {
		for _, e := range localBlock {
			if errors.Is(err, e) {
				return nil
			}
		}
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return fmt.Errorf("was not refused (no answer within %s)", timeout)
	}
	var se syscall.Errno
	if errors.As(err, &se) {
		return fmt.Errorf("was not refused by the firewall (%s)", se.Error())
	}
	return fmt.Errorf("was not refused by the firewall (%v)", err)
}

// localBlock: errors that come back at once for a remote target that nothing can leave for (expectRefused).
var localBlock = []syscall.Errno{syscall.ENETUNREACH, syscall.EHOSTUNREACH, syscall.EACCES, syscall.EPERM, syscall.EINVAL}

var dial = net.DialTimeout
