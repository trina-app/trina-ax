package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"

	"mycel/native/internal/bundle"
)

// The database's reader level (server/src/db.ts): a migration an older build cannot live with declares
// `-- min_compatible_reader: N`, and a build refuses (exit 75) a database whose applied migrations need a higher level
// than its SCHEMA_READER_LEVEL. A dev build (0.5.3-dev.x, level 7) sorts before its stable release (0.5.3, level 6):
// installing that release only replaced the root programs, exited 75 three times and rolled back, again after every
// hold. So mycel-ctl leaves a release whose reader level is below the database's.

var minReaderLine = regexp.MustCompile(`--\s*min_compatible_reader:\s*(\d+)`)

// readerLevel is server/src/system/update.ts bundleReaderLevel (and install-linux.sh reader_level): the highest
// min_compatible_reader in the first 400 bytes of a version folder's server/migrations/*.sql, 1 when none says more.
// Each raise of SCHEMA_READER_LEVEL comes with a migration that declares it, so this is the level the version reads.
// The files are read without following a link, at most 400 bytes each (the running version's folder belongs to the
// server account).
func readerLevel(dir string) int {
	lvl := 1
	ents, err := os.ReadDir(filepath.Join(dir, "server", "migrations"))
	if err != nil {
		return lvl
	}
	for _, d := range ents {
		if !strings.HasSuffix(d.Name(), ".sql") || !d.Type().IsRegular() {
			continue
		}
		head, err := readHead(filepath.Join(dir, "server", "migrations", d.Name()), 400)
		if err != nil {
			continue
		}
		if m := minReaderLine.FindSubmatch(head); m != nil {
			if n, err := strconv.Atoi(string(m[1])); err == nil && n > lvl {
				lvl = n
			}
		}
	}
	return lvl
}

// readHead reads the first n bytes of a regular file, without following a link.
func readHead(p string, n int64) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", p)
	}
	return io.ReadAll(io.LimitReader(f, n))
}

// readMinReader reads the feed's minReaderRequired leniently (like the server's zod .catch): a whole number of at
// least 1, else 0 (unknown), never a reason to refuse the feed.
func readMinReader(raw json.RawMessage) int {
	var n float64
	if len(raw) == 0 || json.Unmarshal(raw, &n) != nil || n < 1 || n != float64(int(n)) || n > 1e6 {
		return 0
	}
	return int(n)
}

// dbReaderLevel is the reader level the database needs now: that of the version that runs (app/current). A running
// build has applied all its migrations, and it would have refused a database that needs more than it reads, so the two
// are the same. 0: unknown (no app/current), nothing is checked.
func (u *updater) dbReaderLevel() int {
	if u.res.From == "" || !bundle.ValidVersion(u.res.From) {
		return 0
	}
	return readerLevel(filepath.Join(u.e.base, "app", "versions", u.res.From))
}

// unreadable says why release v, whose reader level is level (0: unknown), cannot open this server's database, or ""
// when it can (or nobody can tell).
func (u *updater) unreadable(v string, level int) string {
	if level <= 0 {
		return ""
	}
	need := u.dbReaderLevel()
	if need <= level {
		return ""
	}
	return fmt.Sprintf("release %s cannot open this server's data yet: it reads database level %d, and %s has already updated the database to level %d. Waiting for a newer release", v, level, u.res.From, need)
}

// unreadableByHand: an administrator asked for that release (--version, --bundle); nothing was replaced.
func unreadableByHand(why string) string {
	return strings.TrimSuffix(why, ". Waiting for a newer release") + ". Nothing was changed; to run it, restore a backup made before the database was updated (docs/BACKUP-RESTORE.md)"
}
