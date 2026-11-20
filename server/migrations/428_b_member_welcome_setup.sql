-- min_compatible_reader: 1
-- Component B: "My setup" for the team's owner too (docs/decisions/20261120-my-setup-card.md).
--   member_welcome.setup: 1 for the owner's own card, made when the team setup reached its end screen (joined_at is
--     then, so its 14 days count from the end of the setup). Its via is 'invite' with no inviter: the CHECK has no
--     other value, and only via = 'admin' is read elsewhere (the first sign-in's announcement).
-- Additive only (reader 1): an older build ignores the column, and shows no card to an owner.
ALTER TABLE member_welcome ADD COLUMN setup INTEGER NOT NULL DEFAULT 0;
