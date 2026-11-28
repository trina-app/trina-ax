-- min_compatible_reader: 1
-- Component B: a linked browser profile's account and browser (docs/decisions/20261128-chrome-profiles-connect.md).
-- email: the Google account that profile is signed in to, as the extension read it (chrome.identity, null when the
-- profile is not signed in to Chrome); the profile's default name and the AI's way to tell profiles apart.
-- browser: "Chrome on Mac", what the extension says it runs in.
-- 465: 464 is the highest b on dev. Additive only (reader 1): an older build ignores the columns.
ALTER TABLE chrome_links ADD COLUMN email TEXT;
ALTER TABLE chrome_links ADD COLUMN browser TEXT;
