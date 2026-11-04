package main

// The staged roll-out of a release, exactly as server/src/system/rollout.ts decides it (testdata/rollout.json is
// checked by both sides: TestRolloutMatchesServer here, tests/unit/g-rollout.test.ts there). The root update timer
// (`mycel-ctl update --scheduled`, update.go gate) takes a release only when it is this server's turn; an
// administrator's `mycel-ctl update` never asks.
//
// The feed's rollout is { percent, salt, ramp? }: the server's bucket is the first two bytes (big-endian) of
// sha256(salt + install id), modulo 100, and it takes the release while bucket < percent. ramp moves the percent with
// the time since the feed's signed publishedAt: the step with the largest afterHours that has passed (none: 0). An
// urgent release and the beta channel take percent alone, and so does a server whose app does not know ramp. A server
// without an install id is in the last bucket (99): the 100% step, never earlier and never later.

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"mycel/native/internal/bundle"
)

type rampStep struct {
	AfterHours float64 `json:"afterHours"`
	Percent    float64 `json:"percent"`
}

type rolloutSpec struct {
	Percent float64    `json:"percent"`
	Salt    string     `json:"salt"`
	Ramp    []rampStep `json:"ramp"`
}

// lastBucket: an install without an install id takes the release at the 100% step
const lastBucket = 99

// installIDRe is the app's rule for MYCEL_INSTALL_ID (server/src/admin/settings.ts installId)
var installIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

func rolloutBucket(salt, installID string) int {
	if installID == "" {
		return lastBucket
	}
	h := sha256.Sum256([]byte(salt + installID))
	return int(binary.BigEndian.Uint16(h[:2]) % 100)
}

// publishedMs reads publishedAt (RFC 3339, as the TS side's ISO_TIME accepts it); ok false when it cannot.
func publishedMs(s string) (int64, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}

// pickStep: the largest afterHours (a tie: the larger percent) among the steps ok accepts
func pickStep(ramp []rampStep, ok func(rampStep) bool) (rampStep, bool) {
	var best rampStep
	found := false
	for _, s := range ramp {
		if !ok(s) {
			continue
		}
		if !found || s.AfterHours > best.AfterHours || (s.AfterHours == best.AfterHours && s.Percent > best.Percent) {
			best, found = s, true
		}
	}
	return best, found
}

const hourMs = 3_600_000

func skipsRamp(f *ReleaseFeed, channel string) bool { return f.Urgent || channel == "beta" }

// rolloutPercent: the percent of servers that take the release by themselves at now.
func rolloutPercent(f *ReleaseFeed, channel string, now time.Time) float64 {
	r := f.Rollout
	if r == nil {
		return 100
	}
	if len(r.Ramp) == 0 || skipsRamp(f, channel) {
		return r.Percent
	}
	at, ok := publishedMs(f.PublishedAt)
	if !ok {
		s, _ := pickStep(r.Ramp, func(rampStep) bool { return true })
		return s.Percent
	}
	elapsed := float64(max(0, now.UnixMilli()-at))
	if s, ok := pickStep(r.Ramp, func(s rampStep) bool { return s.AfterHours*hourMs <= elapsed }); ok {
		return s.Percent
	}
	return 0
}

func inRollout(f *ReleaseFeed, installID, channel string, now time.Time) bool {
	if f.Rollout == nil {
		return true
	}
	return float64(rolloutBucket(f.Rollout.Salt, installID)) < rolloutPercent(f, channel, now)
}

// rolloutWait says whether this server waits for its turn; at is that turn (nil: this release's roll-out leaves the
// server out).
type rolloutWait struct {
	wait   bool
	at     *time.Time
	bucket int
}

func rolloutTurn(f *ReleaseFeed, installID, channel string, now time.Time) rolloutWait {
	if inRollout(f, installID, channel, now) {
		return rolloutWait{}
	}
	w := rolloutWait{wait: true, bucket: rolloutBucket(f.Rollout.Salt, installID)}
	at, ok := publishedMs(f.PublishedAt)
	if len(f.Rollout.Ramp) == 0 || skipsRamp(f, channel) || !ok {
		return w
	}
	seen := map[int64]bool{}
	var times []int64
	for _, s := range f.Rollout.Ramp {
		t := int64(math.Ceil(float64(at) + s.AfterHours*hourMs))
		if t > now.UnixMilli() && !seen[t] {
			seen[t] = true
			times = append(times, t)
		}
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	for _, t := range times {
		if tt := time.UnixMilli(t).UTC(); inRollout(f, installID, channel, tt) {
			w.at = &tt
			return w
		}
	}
	return w
}

// detail is what the scheduled run and `mycel-ctl status` say while the server waits (times in loc).
func (w rolloutWait) detail(version string, loc *time.Location) string {
	turn := "this release's roll-out leaves this server out"
	if w.at != nil {
		turn = "this server's turn comes at " + w.at.In(loc).Format("2006-01-02 15:04 MST")
	}
	return fmt.Sprintf("release %s is in a staged roll-out: %s (`sudo mycel-ctl update` installs it now)", version, turn)
}

// installIDOf is the install id the app uses (server/src/admin/settings.ts installId): MYCEL_INSTALL_ID of
// /etc/default/<id> (the server unit's environment), else the one admin.js update-window read from the app's settings
// (s.installID), else "" (the last bucket).
func installIDOf(in *Install, s updateSchedule) string {
	if v := defaultsValue(in.ID, "MYCEL_INSTALL_ID"); installIDRe.MatchString(v) {
		return v
	}
	return s.installID
}

// serverChannel is config/server.json update.channel (the app's own channel), "stable" when unset or unreadable.
func serverChannel(base string) string {
	b, err := readSmall(filepath.Join(base, "config", "server.json"), 256<<10)
	if err != nil {
		return "stable"
	}
	var c serverJSON
	if json.Unmarshal(b, &c) != nil || c.Update.Channel != "beta" {
		return "stable"
	}
	return "beta"
}

// appCheckedFeed is the release the app found at its last feed check (data/update-check.json, the server account's
// file: signature-checked by the app, shown here only), nil for none.
func appCheckedFeed(base string) *ReleaseFeed {
	b, err := readSmall(filepath.Join(base, "data", "update-check.json"), 1<<20)
	if err != nil {
		return nil
	}
	var rec struct {
		Feed *ReleaseFeed `json:"feed"`
	}
	if json.Unmarshal(b, &rec) != nil || rec.Feed == nil || !bundle.ValidVersion(rec.Feed.Version) {
		return nil
	}
	return rec.Feed
}
