-- Onboarding stream D: chats that draft the team's company profile (docs/DECISIONS.md "D — Company profile from the
-- company website"). A row marks a chat of an owner or admin as a profile draft: every turn of it runs with web_fetch
-- only, on `site` (the registrable domain of the address they typed, at most 4 pages per answer), or with no tool at
-- all for pasted text (`source` 'text'), and its answers are read as a JSON draft (server/src/onboarding/draft.ts).
-- The person saves the profile themselves (PUT /api/onboarding/profile); nothing here is the profile.
-- Additive only (reader 1): an older build does not know the table and runs such a chat as an ordinary one.
CREATE TABLE onboarding_profile_drafts (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('website', 'text')),
  website TEXT NOT NULL DEFAULT '',
  site TEXT,
  created_at TEXT NOT NULL
);
