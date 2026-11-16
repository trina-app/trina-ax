package main

// engineCheck on macOS: nothing is run. The check is for the Linux engine sandbox (bubblewrap), and the bootstrap asks
// for it only on Linux.
func engineCheck() (skipped string, err error) { return "no engine check on macOS", nil }

func checkTurnEnv(dir, bridge string) *turnEnv { return &turnEnv{chat: dir, bridge: bridge} }
