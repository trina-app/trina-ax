-- min_compatible_reader: 1
-- Component B: "My setup" for the team's owner too (docs/decisions/20261120-my-setup-card.md).
--   member_welcome.setup: 1 for the owner's own card, made when the team setup ended (its end screen, or ✕ on it held;
--     onboarding/my-setup.ts). joined_at is then, so its 14 days count from the setup's end. Its via is 'invite' with no
--     inviter (the CHECK has no other value); the first sign-in's announcement reads only via = 'admin'. Like a member's
--     row, it holds the owner's connection template notices for the templates already there (notifications/service.ts
--     offerTemplates) until they open Connected apps or its days are over.
--   member_welcome.tools_at: the card's "Connect your tools" has nothing left to connect (every tool it offers is one
--     the team connected for everyone): counted as done.
-- Additive only (reader 1): an older build ignores the columns, and shows no card to an owner.
ALTER TABLE member_welcome ADD COLUMN setup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member_welcome ADD COLUMN tools_at TEXT;
