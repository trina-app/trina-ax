-- Component A: temporary passwords (admin "add member" / "new temporary password") are one-time and short-lived.
-- users.temp_password_expires_at: set while the account's password is a temporary one (must_change_password = 1);
--   sign-in with it is refused after this time (7 days after it was set), and it is set to the moment of the 20th
--   wrong try (voided). NULL = not a temporary password (or set before this migration and given 7 days below).
-- users.temp_password_failures: wrong sign-in tries against the current temporary password.
-- sessions.temp_login: 1 = this session was made by signing in with a temporary password. Only such a session may
--   set the new password without typing the temporary one again (and only while the account must still change it);
--   it lives one hour, and becomes a normal 30-day session when the password is changed.
-- Additive only: older builds ignore the new columns.
ALTER TABLE users ADD COLUMN temp_password_expires_at TEXT;
ALTER TABLE users ADD COLUMN temp_password_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN temp_login INTEGER NOT NULL DEFAULT 0;
UPDATE users SET temp_password_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days') WHERE must_change_password = 1 AND deleted_at IS NULL;
