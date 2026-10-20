package peer

// Proc is one process of the current uid (for orphan reaping).
type Proc struct{ Pid, Ppid, Sid int }

// OwnProcs lists processes running as uid.
func OwnProcs(uid int) ([]Proc, error) { return ownProcs(uid) }
