package bootflags

import (
	"testing"
	"time"
)

func TestMigrateTimeout(t *testing.T) {
	for _, c := range []struct {
		args []string
		want time.Duration
	}{
		{nil, DefaultMigrateTimeout},
		{[]string{"/b/root/mycel-bootstrap", "--app", "/b/app", "--config", "/b/config/server.json"}, DefaultMigrateTimeout},
		{[]string{"/b/root/mycel-bootstrap", "--app", "/b/app", "--migrate-timeout", "90m", "--allow-unsigned"}, 90 * time.Minute},
		{[]string{"x", "-migrate-timeout=2h"}, 2 * time.Hour},
		{[]string{"x", "--migrate-timeout=10m", "--migrate-timeout", "20m"}, 20 * time.Minute},
		{[]string{"x", "--migrate-timeout", "soon"}, DefaultMigrateTimeout},
		{[]string{"x", "--migrate-timeout=0s"}, 0}, // as the bootstrap: no time for a migration
		{[]string{"x", "--migrate-timeout"}, DefaultMigrateTimeout},
		{[]string{"x", "--", "--migrate-timeout", "5m"}, DefaultMigrateTimeout},
		{[]string{"x", "--migrate-timeouts", "5m"}, DefaultMigrateTimeout},
		{[]string{"x", "--migrate-timeout", `"2h"`}, 2 * time.Hour}, // a unit file's quotes
	} {
		if got := MigrateTimeout(c.args); got != c.want {
			t.Errorf("%q: %v, want %v", c.args, got, c.want)
		}
	}
}
