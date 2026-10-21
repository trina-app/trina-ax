-- Component A: a person's language can follow the team default instead of being their own choice.
-- 1 = no own choice: users.locale is kept equal to the team default (rewritten when an admin changes the default).
-- 0 = users.locale is the person's own choice. Existing rows keep 0, so everyone already there keeps the language
-- they have (no row is rewritten). Additive only: older builds keep reading users.locale as before.
ALTER TABLE users ADD COLUMN locale_follows_team INTEGER NOT NULL DEFAULT 0;
