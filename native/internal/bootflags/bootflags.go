// Package bootflags: the mycel-bootstrap flags another program must agree with. `mycel-ctl update` waits for a version
// that reports it is updating its database (/api/health status "migrating") as long as the bootstrap does: the
// bootstrap's --migrate-timeout, read from the bootstrap's own command line (the server unit's ExecStart), with the same
// default when the unit does not set it (QA TC-278 follow-up).
package bootflags

import (
	"strings"
	"time"
)

// DefaultMigrateTimeout is mycel-bootstrap's --migrate-timeout when the command line does not set it.
const DefaultMigrateTimeout = 60 * time.Minute

// MigrateTimeout returns the --migrate-timeout a bootstrap command line sets (the arguments, the program may be args[0]),
// DefaultMigrateTimeout when it sets none or one that is not a duration (the bootstrap would not start then). Go's flag
// syntax: -migrate-timeout or --migrate-timeout, with "=value" or the value as the next argument; the last one wins, as in the bootstrap; nothing
// after "--" counts.
func MigrateTimeout(args []string) time.Duration {
	d := DefaultMigrateTimeout
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			break
		}
		name, val, hasVal := strings.Cut(strings.TrimPrefix(strings.TrimPrefix(a, "-"), "-"), "=")
		if name != "migrate-timeout" {
			continue
		}
		if !hasVal {
			if i+1 >= len(args) {
				break
			}
			i++
			val = args[i]
		}
		if v, err := time.ParseDuration(strings.Trim(val, `"'`)); err == nil {
			d = v
		}
	}
	return d
}
