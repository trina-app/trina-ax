// `security` for a local-login Claude turn (TC-358): the engine sandbox does not let a turn run /usr/bin/security or
// open the keychain, so the launcher links this program as <kc>/security, first in the engine's PATH, and Claude Code
// runs it to read and save its login. It passes its arguments (and, for `security -i`, its stdin) to the launcher's
// Claude login broker (native/cmd/mycel-launcher/keychain.go), which decides what is answered: only the Claude login
// item of the Mac user. The shim checks nothing itself; a process of the turn that talks to the socket directly gets
// the same answers.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"time"
)

const shimMaxStdin = 64 << 10

func securityShim(args []string, stdin io.Reader, stdout, stderr io.Writer, sock string) int {
	if sock == "" {
		fmt.Fprintln(stderr, "security: the keychain is not available to this program")
		return 1
	}
	req := map[string]any{"args": args}
	if len(args) == 1 && args[0] == "-i" {
		b, err := io.ReadAll(io.LimitReader(stdin, shimMaxStdin+1))
		if err != nil || len(b) > shimMaxStdin {
			fmt.Fprintln(stderr, "security: input too large")
			return 1
		}
		req["stdin"] = string(b)
	}
	c, err := net.DialTimeout("unix", sock, 5*time.Second)
	if err != nil {
		fmt.Fprintln(stderr, "security: the team server's keychain broker is not reachable")
		return 1
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	j, _ := json.Marshal(req)
	if _, err := c.Write(append(j, '\n')); err != nil {
		fmt.Fprintln(stderr, "security:", err)
		return 1
	}
	line, err := bufio.NewReaderSize(c, 1<<20).ReadBytes('\n')
	var resp struct {
		Code   int    `json:"code"`
		Stdout string `json:"stdout"`
		Stderr string `json:"stderr"`
	}
	if len(line) == 0 || json.Unmarshal(line, &resp) != nil {
		fmt.Fprintln(stderr, "security: no answer from the keychain broker", err)
		return 1
	}
	_, _ = io.WriteString(stdout, resp.Stdout)
	_, _ = io.WriteString(stderr, resp.Stderr)
	return resp.Code
}
