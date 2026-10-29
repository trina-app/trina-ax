package main

import (
	"fmt"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// The server prepares local-login homes. Preserve only a real directory beneath
// this chat's open root; the auth.json symlink inside it is intentional.
func keepLocalCodexHome(req *request, chat string, root *dirRoot) (bool, error) {
	if !*localLogin || !*localCodex || req.CodexAuth || req.CodexHome != nil ||
		req.Env["CODEX_HOME"] != filepath.Join(chat, ".codex") {
		return false, nil
	}
	fd, err := root.open(".codex", unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return false, fmt.Errorf("local Codex home must be a real directory in this chat: %w", err)
	}
	_ = unix.Close(fd)
	return true, nil
}
