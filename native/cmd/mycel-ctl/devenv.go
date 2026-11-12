package main

// The dev environment on srt after an update (docs/DECISIONS.md "Dev environment: the installer turns srt on"). A
// self-installed server has root's copy of scripts/dev-env/srt in root/dev-env-srt/ (install-linux.sh runs
// install-srt.sh from it). When an update brings new files there and srt is on here (the server drop-in that
// install-srt.sh writes names MYCEL_DEV_ENV_RUNNER=srt), the new install-srt.sh runs once: a new pinned srt or node, a
// new run-wrap or slice. A re-run changes only what changed and restarts the server only then. A failure is a note:
// the server keeps running with the dev environment it had.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const devEnvRootDir = "dev-env-srt"

var devEnvTimeout = 15 * time.Minute

// devEnvOn: install-srt.sh's drop-in of the team server is there
func devEnvOn(id string) bool {
	b, err := os.ReadFile(filepath.Join(systemdUnitDir, id+"-server.service.d", "dev-env.conf"))
	return err == nil && strings.Contains(string(b), "MYCEL_DEV_ENV_RUNNER=srt")
}

func (u *updater) devEnvAfter() {
	if !u.devEnvIn || !u.in.Systemd || !devEnvOn(u.in.ID) {
		return
	}
	script := u.e.root(devEnvRootDir, "install-srt.sh")
	if !fileExists(script) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), devEnvTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bashPath, script, "--id", u.in.ID).CombinedOutput()
	if err != nil {
		u.res.Notes = append(u.res.Notes, fmt.Sprintf("the dev environment (srt) did not take this version's files: %v %s. Retry: sudo bash %s --id %s", err, lastLine(out), script, u.in.ID))
		return
	}
	u.res.Notes = append(u.res.Notes, "the dev environment (srt) has this version's files")
}

// lastLine: the last non-empty line of a command's output (its STOP line)
func lastLine(out []byte) string {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
