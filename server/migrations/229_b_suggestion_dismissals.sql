-- min_compatible_reader: 1
-- Stream X (lean onboarding): suggestions under answers that a person closed (docs/DECISIONS.md "X — Lean
-- onboarding"). One line under a result at most ("매주 이 시간에 자동으로 받을까요?" [예약하기], [PPT로 만들기]); once a
-- person closes one it never comes back for them, on any device, so it is kept per person on the server, not in the
-- browser. `key`: 'ppt' or 'schedule:<team skill path>' (server/src/onboarding/suggestions.ts).
-- Additive only (reader 1): an older build does not know the table.
CREATE TABLE suggestion_dismissals (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
