-- min_compatible_reader: 8
-- (the guests table it changes is 122_a_guests.sql's, which needs reader level 8 already: an older reader never has it)
-- Component A: Admin tells a guest who left on their own from one who was taken out or removed (docs/DECISIONS.md
-- "Guests in Admin: a Home card, left or removed").
--   guests.left_at: when the guest switched themselves off by leaving their one place (the room service's leave: the
--     leaver is the actor, admin/guests.ts disableGuestIfPlaceless); NULL otherwise, and cleared by any switch an admin
--     makes by hand (on or off). A column, not the activity log: the log is purged after its retention.
ALTER TABLE guests ADD COLUMN left_at TEXT;
-- guests who left before this: the last switch-off of their account was their own (while the log still has it)
UPDATE guests SET left_at = (
  SELECT a.at FROM audit_log a WHERE a.action = 'user.update' AND a.target = guests.user_id
    AND a.detail LIKE '%"status":"disabled"%' ORDER BY a.id DESC LIMIT 1)
WHERE user_id IN (SELECT id FROM users WHERE status <> 'active' AND deleted_at IS NULL)
  AND (SELECT a.actor_id FROM audit_log a WHERE a.action = 'user.update' AND a.target = guests.user_id
    AND a.detail LIKE '%"status":"disabled"%' ORDER BY a.id DESC LIMIT 1) = guests.user_id;
