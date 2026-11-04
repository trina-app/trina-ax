package main

// The staged roll-out of a release, exactly as server/src/system/rollout.ts decides it (testdata/rollout.json is
// checked by both sides: TestRolloutMatchesServer here, tests/unit/g-rollout.test.ts there). The root update timer
// (`mycel-ctl update --scheduled`, update.go gate) takes a release only when it is this server's turn; an
// administrator's `mycel-ctl update` never asks.
//
// The feed's rollout is { percent, salt, ramp?, since? }: the server's bucket is the first two bytes (big-endian) of
// sha256(salt + install id), modulo 100, and it takes the release while bucket < percent. ramp moves the percent with
// the time since the ramp's start (since, when it is a time not after publishedAt and not after now; else the feed's
// signed publishedAt): the step with the largest afterHours that has passed (none: 0). An urgent release and the beta
// channel take percent alone, and so does a server whose app does not know ramp. A server without an install id is in
// the last bucket (99): the 100% step, never earlier and never later.
//
// Read leniently, like the TS side (readRollout): a rollout that cannot be read is none, and a ramp or since that cannot
// be read is left out, so a later change of the format never makes this timer refuse the whole feed.

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"time"
	"unicode/utf8"

	"mycel/native/internal/bundle"
)

type rampStep struct {
	AfterHours float64 `json:"afterHours"`
	Percent    float64 `json:"percent"`
}

type rolloutSpec struct {
	Percent float64    `json:"percent"`
	Salt    string     `json:"salt"`
	Ramp    []rampStep `json:"ramp,omitempty"`
	Since   string     `json:"since,omitempty"`
}

// UnmarshalJSON reads the feed with its rollout read leniently (readRollout): never an error because of it.
func (f *ReleaseFeed) UnmarshalJSON(b []byte) error {
	type plain ReleaseFeed
	var x struct {
		plain
		RolloutRaw json.RawMessage `json:"rollout"`
	}
	if err := json.Unmarshal(b, &x); err != nil {
		return err
	}
	*f = ReleaseFeed(x.plain)
	f.Rollout = readRollout(x.RolloutRaw)
	return nil
}

// readRollout reads a feed's rollout as server/src/system/rollout.ts readRollout does: nil when it is absent or cannot be
// read (not an object; percent not a number in 0-100; salt not a string of at most 100 characters: code points, as zod counts them); a ramp that is not
// an array of at most 20 steps with afterHours in 0-8760 and percent in 0-100 is left out; so is a since that is not a
// time publishedMs reads. Other keys are ignored.
func readRollout(raw json.RawMessage) *rolloutSpec {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	pct, ok := m["percent"].(float64)
	if !ok || pct < 0 || pct > 100 {
		return nil
	}
	salt, ok := m["salt"].(string)
	if !ok || utf8.RuneCountInString(salt) > 100 {
		return nil
	}
	r := &rolloutSpec{Percent: pct, Salt: salt}
	if steps, ok := m["ramp"].([]any); ok && len(steps) <= 20 {
		ramp := make([]rampStep, 0, len(steps))
		for _, s := range steps {
			o, ok := s.(map[string]any)
			if !ok {
				ramp = nil
				break
			}
			h, hok := o["afterHours"].(float64)
			p, pok := o["percent"].(float64)
			if !hok || !pok || h < 0 || h > 8760 || p < 0 || p > 100 {
				ramp = nil
				break
			}
			ramp = append(ramp, rampStep{AfterHours: h, Percent: p})
		}
		r.Ramp = ramp
	}
	if since, ok := m["since"].(string); ok {
		if _, ok := publishedMs(since); ok {
			r.Since = since
		}
	}
	return r
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

// isoTime is the TS side's ISO_TIME (rollout.ts): time.Parse alone also takes a comma before the fraction, more than
// nine fraction digits and an offset of 24 hours, which the TS side does not.
var isoTime = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$`)

// publishedMs reads publishedAt (RFC 3339, exactly what the TS side's ISO_TIME accepts); ok false when it cannot.
func publishedMs(s string) (int64, bool) {
	if !isoTime.MatchString(s) {
		return 0, false
	}
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

// rampStart: since, when it is a time not after publishedAt and not after now, else publishedAt; ok false when
// publishedAt cannot be read (rollout.ts rampStart).
func rampStart(f *ReleaseFeed, now time.Time) (int64, bool) {
	at, ok := publishedMs(f.PublishedAt)
	if !ok {
		return 0, false
	}
	if f.Rollout != nil {
		if since, ok := publishedMs(f.Rollout.Since); ok && since <= at && since <= now.UnixMilli() {
			return since, true
		}
	}
	return at, true
}

// percentAt: the percent at nowMs of a ramp that started at start (startOK false: publishedAt cannot be read, the last
// step)
func percentAt(ramp []rampStep, start int64, startOK bool, nowMs int64) float64 {
	if !startOK {
		s, _ := pickStep(ramp, func(rampStep) bool { return true })
		return s.Percent
	}
	elapsed := float64(max(0, nowMs-start))
	if s, ok := pickStep(ramp, func(s rampStep) bool { return s.AfterHours*hourMs <= elapsed }); ok {
		return s.Percent
	}
	return 0
}

// rolloutPercent: the percent of servers that take the release by themselves at now.
func rolloutPercent(f *ReleaseFeed, channel string, now time.Time) float64 {
	r := f.Rollout
	if r == nil {
		return 100
	}
	if len(r.Ramp) == 0 || skipsRamp(f, channel) {
		return r.Percent
	}
	start, ok := rampStart(f, now)
	return percentAt(r.Ramp, start, ok, now.UnixMilli())
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
	start, ok := rampStart(f, now)
	if len(f.Rollout.Ramp) == 0 || skipsRamp(f, channel) || !ok {
		return w
	}
	seen := map[int64]bool{}
	var times []int64
	for _, s := range f.Rollout.Ramp {
		t := int64(math.Ceil(float64(start) + s.AfterHours*hourMs))
		if t > now.UnixMilli() && !seen[t] {
			seen[t] = true
			times = append(times, t)
		}
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	for _, t := range times {
		if float64(w.bucket) < percentAt(f.Rollout.Ramp, start, true, t) {
			tt := time.UnixMilli(t).UTC()
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
