// mycel-gate: listens on the public tools.sock, reads the peer credentials of every connecting process
// (pid, uid, gid, process group, session) and forwards the connection to the server's private socket,
// prefixed with one line {"gate":{secret, pid, uid, gid, pgid, sid}}. The secret arrives on stdin (first
// line) when the server starts the gate, so a process that can reach the private socket cannot forge
// peer data without it. Bun has no API for SO_PEERCRED / LOCAL_PEERPID; this is that small native piece.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"mycel/native/internal/peer"
)

func main() {
	listen := flag.String("listen", "", "public socket path (tools.sock)")
	upstream := flag.String("upstream", "", "server private socket path")
	mode := flag.String("mode", "0600", "socket file mode (octal)")
	flag.Parse()
	if *listen == "" || *upstream == "" {
		fmt.Fprintln(os.Stderr, "usage: mycel-gate --listen <tools.sock> --upstream <server.sock> [--mode 0660] < secret")
		os.Exit(2)
	}
	secret, err := bufio.NewReader(os.Stdin).ReadString('\n')
	secret = strings.TrimSpace(secret)
	if err != nil && secret == "" || len(secret) < 32 {
		fmt.Fprintln(os.Stderr, "mycel-gate: secret missing on stdin")
		os.Exit(2)
	}
	_ = os.Remove(*listen)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: *listen, Net: "unix"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "mycel-gate:", err)
		os.Exit(1)
	}
	m, _ := strconv.ParseUint(*mode, 8, 32)
	_ = os.Chmod(*listen, os.FileMode(m))
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() { <-sigs; _ = os.Remove(*listen); os.Exit(0) }()
	fmt.Println("ready")
	for {
		c, err := ln.AcceptUnix()
		if err != nil {
			continue
		}
		go handle(c, *upstream, secret)
	}
}

func handle(c *net.UnixConn, upstream, secret string) {
	defer c.Close()
	cr, err := peer.Of(c)
	if err != nil {
		msg, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32001, "message": "peer check failed: " + err.Error()}})
		_, _ = c.Write(append(msg, '\n'))
		return
	}
	u, err := net.Dial("unix", upstream)
	if err != nil {
		return
	}
	defer u.Close()
	head, _ := json.Marshal(map[string]any{"gate": map[string]any{"secret": secret, "pid": cr.Pid, "uid": cr.Uid, "gid": cr.Gid, "pgid": cr.Pgid, "sid": cr.Sid}})
	if _, err := u.Write(append(head, '\n')); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(u, c); _ = u.(*net.UnixConn).CloseWrite(); done <- struct{}{} }()
	go func() { _, _ = io.Copy(c, u); _ = c.CloseWrite(); done <- struct{}{} }()
	<-done
	<-done
}
