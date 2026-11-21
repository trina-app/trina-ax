package main

// engineCheck on Linux: with --sandbox bwrap the bubblewrap launch of a turn; without it the bridge started directly
// as this account (what a turn without the sandbox does). Never skipped: both are the platform's own launch.
func engineCheck() (skipped string, err error) { return "", runEngineCheck() }

// checkTurnEnv: what beginLoginAs builds (no turn token, no Codex lock files), with the bridge the check resolved
func checkTurnEnv(dir, bridge string) *turnEnv {
	return &turnEnv{chat: dir, login: true, bridge: bridge}
}
