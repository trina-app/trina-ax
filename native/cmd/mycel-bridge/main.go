// mycel-bridge: the engine's MCP "server" (stdio). It forwards JSON-RPC to the tool gate's Unix socket.
// The turn token is read from <turn-dir>/.turn/token, which is deleted right after reading. The token is
// never taken from argv or the environment (other processes of the same account could read those).
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	turnDir := flag.String("turn-dir", "", "chat folder that contains .turn/token")
	sock := flag.String("sock", "", "tools.sock path")
	flag.Parse()
	if *turnDir == "" || *sock == "" {
		fail("usage: mycel-bridge --turn-dir <dir> --sock <tools.sock>")
	}
	tokPath := filepath.Join(*turnDir, ".turn", "token")
	b, err := os.ReadFile(tokPath)
	if err != nil {
		fail("no turn token: " + err.Error())
	}
	_ = os.Remove(tokPath)
	token := strings.TrimSpace(string(b))
	c, err := net.Dial("unix", *sock)
	if err != nil {
		fail("cannot reach tools: " + err.Error())
	}
	hello, _ := json.Marshal(map[string]any{"hello": map[string]string{"token": token}})
	token = ""
	if _, err := c.Write(append(hello, '\n')); err != nil {
		fail(err.Error())
	}
	done := make(chan struct{}, 2)
	go func() { // engine -> tools
		r := bufio.NewReaderSize(os.Stdin, 1<<20)
		_, _ = io.Copy(c, r)
		if uc, ok := c.(*net.UnixConn); ok {
			_ = uc.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() { // tools -> engine
		_, _ = io.Copy(os.Stdout, c)
		done <- struct{}{}
	}()
	<-done
	os.Exit(0)
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "mycel-bridge:", msg)
	os.Exit(1)
}
