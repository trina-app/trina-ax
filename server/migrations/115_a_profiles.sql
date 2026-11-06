-- Component A: a person's profile line and photo (docs/DECISIONS.md "프로필과 사람 목록"). A row exists only for people who
-- set something. The photo is a small square image (at most 256 KiB, metadata cut out) kept here, not in a file, so a
-- backup restores it with the person and deleting the person deletes it.
-- avatar_version is a millisecond clock that only grows, so an address with ?v=<it> is never reused for another photo;
-- NULL = no photo. Additive only: older builds ignore the table.
CREATE TABLE user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  status_text TEXT NOT NULL DEFAULT '',
  avatar BLOB,
  avatar_type TEXT,
  avatar_version INTEGER
);
