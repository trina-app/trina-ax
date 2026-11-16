// Engine check after an update (QA TC-3523, docs/decisions/20261116-post-update-engine-check.md).
//
// /api/health says the server runs; it does not say that the engine account can start the engine. On 2026-11-16 an
// app-only update left the new version folder 0750/0640: the server answered health, the bootstrap kept the version,
// and every AI answer failed for hours (bwrap: Can't find source path …/native/mycel-bridge: Permission denied). So on
// Linux a pending version that answers health is kept only after the launcher, which runs as the engine account,
// starts the engine's sandbox with this version once with a no-op (native/cmd/mycel-launcher/enginecheck.go: the same
// launch code as a turn). A failed check is a failed update: the version is stopped and rolled back with the reason.
//
// The check proves a fault only when the launcher says it failed. Nothing to ask (not Linux), no launcher answering
// within engineConnectWait, or a launcher that does not know the request (one older than this bootstrap): the version
// is kept as before and the log says the check was skipped.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type engineResult struct {
	failed  string // the launcher's reason; the version must not stay
	skipped string // why nothing was checked; the version stays
}

// tunables (tests change them)
var (
	bootOS            = runtime.GOOS
	engineConnectWait = 30 * time.Second // the launcher may be restarting (an update with root files)
	engineAnswerWait  = 30 * time.Second // the launcher's own launch limit is 15 s
)

func launcherSocket() string {
	if *launcherSock != "" {
		return *launcherSock
	}
	return filepath.Join(filepath.Dir(*appDir), "run-launcher", "launcher.sock")
}

func startEngineCheck() <-chan engineResult {
	ch := make(chan engineResult, 1)
	go func() { ch <- checkEngine() }()
	return ch
}

func checkEngine() engineResult {
	if bootOS != "linux" {
		return engineResult{} // no engine sandbox to check (macOS, development): nothing asked, nothing logged
	}
	sock := launcherSocket()
	var c net.Conn
	var err error
	for until := time.Now().Add(engineConnectWait); ; {
		if c, err = net.DialTimeout("unix", sock, 3*time.Second); err == nil {
			break
		}
		if time.Now().After(until) {
			return engineResult{skipped: fmt.Sprintf("the launcher did not answer at %s: %v", sock, err)}
		}
		time.Sleep(min(time.Second, max(time.Until(until), 10*time.Millisecond)))
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(engineAnswerWait))
	if _, err := c.Write([]byte(`{"op":"sandbox-check"}` + "\n")); err != nil {
		return engineResult{skipped: "the launcher did not take the request: " + err.Error()}
	}
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		// no answer within the time, or the launcher went away (a restart under the check): no proof against the version
		return engineResult{skipped: "no answer from the launcher: " + err.Error()}
	}
	var ev struct {
		Ev      string `json:"ev"`
		Ok      bool   `json:"ok"`
		Skipped string `json:"skipped"`
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return engineResult{skipped: "the launcher's answer is not readable: " + strings.TrimSpace(string(line))}
	}
	switch {
	case ev.Ev != "sandbox-check":
		// an older launcher answers {"ev":"error","message":"bad request"}
		return engineResult{skipped: "the launcher does not know the engine check: " + orDash(ev.Message)}
	case !ev.Ok:
		why := strings.TrimSpace(ev.Error)
		if why == "" {
			why = "the launcher's engine check failed"
		}
		return engineResult{failed: why}
	default:
		return engineResult{skipped: ev.Skipped}
	}
}
