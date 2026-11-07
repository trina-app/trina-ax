-- min_compatible_reader: 1
-- Component B: "@전체" in team chat rooms (docs/DECISIONS.md "@전체"). Additive only.
--   room_messages.mentions_all: 1 when the sender picked "@전체" (everyone) from the "@" list: the message mentions every
--     member who can see it (never its sender), so it notifies them as a mention would. The text keeps "@전체" as typed;
--     only this flag notifies (a pasted "@전체" is text). An older build ignores the column: there the message is a plain
--     one, its "@전체" plain text.
-- Numbered 259: 256 is reserved for session markers and 258 is taken by another branch.
ALTER TABLE room_messages ADD COLUMN mentions_all INTEGER NOT NULL DEFAULT 0;
