-- Team skills (docs/DECISIONS.md "팀 스킬 관리"): skills/ is changed only by the people who manage it (a write rule on
-- skills/ or a subfolder, set from Admin > 멤버 / 그룹 "팀 스킬 관리"; no table of its own). Everyone else can suggest a
-- skill ("스킬로 제안"): the suggestion waits here, never in skills/, until someone who manages the target folder
-- registers it (등록: the file is written under skills/) or turns it down (거절). Additive only.
CREATE TABLE skill_suggestions (
  id TEXT PRIMARY KEY,
  suggester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'skills' or 'skills/<sub>' (actual names when it was made); who may review it is computed from the rules at the
  -- time of reading, so a changed rule never leaves a stale list behind
  target_folder TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'file')),
  -- the message id or the file path it came from (shown to the suggester and the reviewers)
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  review_note TEXT,
  -- the skills/ file it became (approved)
  result_path TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX skill_suggestions_by_status ON skill_suggestions (status, target_folder, created_at);
CREATE INDEX skill_suggestions_by_suggester ON skill_suggestions (suggester_id, created_at);
