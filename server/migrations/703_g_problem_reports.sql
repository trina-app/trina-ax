-- Component G: problem reports' outbox (docs/decisions/20261126-problem-reports.md, server/src/system/problem-reports.ts).
-- A person's "문제 신고" (Settings › About, or 👎 under an AI answer) is kept here until the hosting service's intake
-- took it. body: the exact JSON the sender signs and posts (shared/src/cloud-protocol/problem-report.ts, built from an
-- allow-list); it is set to NULL once the intake took it or the report was dropped, so a sent report keeps only its id,
-- its person, its times and its state. The rows go after 30 days. Additive only.
CREATE TABLE problem_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','dropped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT,
  done_at TEXT,
  last_status INTEGER,
  last_code TEXT
);
CREATE INDEX problem_reports_due ON problem_reports(status, next_at);
CREATE INDEX problem_reports_user ON problem_reports(user_id, created_at);
CREATE INDEX problem_reports_created ON problem_reports(created_at);
