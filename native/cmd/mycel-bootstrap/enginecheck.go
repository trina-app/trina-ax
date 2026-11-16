// Engine check after an update (QA TC-3523, docs/decisions/20261116-post-update-engine-check.md).
//
// /api/health says the server runs; it does not say that the engine account can start the engine. On 2026-11-16 an
// app-only update left the new version folder 0750/0640: the server answered health, the bootstrap kept the version,
// and every AI answer failed for hours (bwrap: Can't find source path …/native/mycel-bridge: Permission denied). So on
// Linux a pending version that answers health is kept only after the launcher, which runs as the engine account,
// starts the engine's sandbox with this version once with a no-op (native/cmd/mycel-launcher/enginecheck.go: the same
// launch code as a turn). A failed check is a failed update: the version is stopped and rolled back with the reason.
//
// The check proves a fault only when the launcher says it failed, which it does only for the version's own files. A fault
// of this machine (bwrap broken by an OS upgrade or AppArmor, the sandbox helper, Landlock gone) breaks the version
// before too: going back would not help and the update would be tried again and again, so the version is kept and the
// history says what is wrong (Admin › System shows it as a warning). Nothing to ask (not Linux), no launcher answering
// (no socket, or one that does not accept within engineConnectWait), or a launcher that does not know the request (one older than this bootstrap): the version
// is kept as before and the log says the check was skipped.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type engineResult struct {
	failed  string // the launcher's reason; the version must not stay
	skipped string // why nothing was checked; the version stays
	// hostProblem: the launch failed for a reason of this machine, not of the version (bwrap, the sandbox helper,
	// Landlock): kept, and the history's ok entry says so (engineHostDetail) for Admin › System's warning
	hostProblem bool
}

// engineHostDetail starts the detail of a kept version whose engine check failed on this machine's own fault
// (server/src/system/ops.ts shows it as a warning)
const engineHostDetail = "kept, but the AI engine could not start on this server: "

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
	// no socket at all: this install has no launcher running here (or not yet); waiting would only delay every update.
	// A socket that does not accept yet is a launcher restarting: tried again for engineConnectWait.
	if _, err := os.Stat(sock); err != nil {
		return engineResult{skipped: fmt.Sprintf("no launcher socket at %s", sock)}
	}
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
		Host    bool   `json:"hostProblem"`
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
		return engineResult{skipped: ev.Skipped, hostProblem: ev.Host && ev.Skipped != ""}
	}
}
