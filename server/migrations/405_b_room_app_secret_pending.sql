-- min_compatible_reader: 1
-- Component B: apps in rooms, a secret Trina makes (GitHub, Typeform, Tally) waits for the service (QA 2026-11-15).
--   secret_pending: 1 while a secret Trina made has not yet been seen on a request. Until the first request whose
--   signature matches it, requests without one are still shown (as before the secret), so copying the secret does not
--   drop what the service sends before the person pastes it there; that first signed request sets it to 0, and from
--   then on only signed requests are shown. A secret the person pastes (the service's own) is 0 from the start.
-- Additive only (reader 1): an older build ignores the column and checks the secret at once, as it did.
ALTER TABLE room_apps ADD COLUMN secret_pending INTEGER NOT NULL DEFAULT 0;
