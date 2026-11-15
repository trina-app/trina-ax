-- min_compatible_reader: 8
-- (the guests table it changes is 122_a_guests.sql's, which needs reader level 8 already: an older reader never has it)
-- Component A: a guest switched off because their place itself went away comes back with it (docs/DECISIONS.md
-- "Guest states: true reasons, a reset AI, and coming back with a restored place").
--   guests.off_with_place: when the server switched the guest off because their one place was closed (the project went
--     to the trash, the group chat was archived), not because they were taken out of it. Restoring the project switches
--     them on again while they are still in it (admin/guests.ts returnGuestsWithPlace); NULL otherwise, and cleared by
--     any switch an admin makes by hand (on or off), so a guest an admin decided about is never switched on by itself.
ALTER TABLE guests ADD COLUMN off_with_place TEXT;
