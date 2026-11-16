-- min_compatible_reader: 8
-- (the guests table it changes is 122_a_guests.sql's, which needs reader level 8 already: an older reader never has it)
-- Component A: a guest is in at most one group chat AND at most one project (owner, 2026-11-15; docs/DECISIONS.md
-- "Guests: one group chat and one project"). One column per kind, so a second place of the same kind cannot even be
-- stored:
--   guests.room_id: the guest's group chat (rooms.id), NULL = none. Set in the write that puts them into it.
--   guests.project_id: the guest's project (projects.id), NULL = none. Set in the write that gives them its folder.
-- Each slot says where the guest is or was last; whether they are in it now is read from the place itself (the room's
-- member rows, the project folder's rules: server/src/auth/guests.ts).
-- guests.place_kind / place_id keep their columns (a table is never rebuilt) and now mean only the place the invite
-- opened, set once at accept; nothing decides access by them any more. A level-8 build reads only that one place, so
-- it can only narrow what a guest reaches, never widen it.
ALTER TABLE guests ADD COLUMN room_id TEXT;
ALTER TABLE guests ADD COLUMN project_id TEXT;
UPDATE guests SET room_id = place_id WHERE place_kind = 'room';
UPDATE guests SET project_id = place_id WHERE place_kind = 'project';
