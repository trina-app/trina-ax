# An Other app shows its first letter, and the people who manage apps can change its icon

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/other-app-icon (the owner, QA TC-3544, TC-3545; plan
  [20261116-0331-other-app-icon.md](../AGENTS/plan/20261116-0331-other-app-icon.md))

- **Ask:** an "Other app" (a Webhook URL with a name people give, such as "Dr Alaseo Alert") showed the same grey
  blocks icon as every other Other app, so three of them in one conversation looked alike.
- **Rule 1, the default:** a plain Other app without its own icon shows its name's first letter (the same letter a
  person without a photo gets, `firstLetter`, components/Avatar.tsx) on a tint picked from the app's id
  (`web/src/lib/appTone.ts`: eight soft tints with a light and a dark form, FNV-1a of the id; a removed app by its
  name). People keep their neutral letter tile (the archive's "Letter avatars are on a neutral tile", 2026-11-05, is
  unchanged); the owner asked for "a stable colour from the app id", and the app has no photo palette to reuse, so
  this palette is the apps' own, never the accent colour. Preset apps (Notion, Stripe, …), Sentry, GitHub and Google
  Forms keep their marks.
- **Rule 2, Change icon:** the app's settings have one **Change icon** menu: **Upload an image**, **Pick an emoji**,
  **Remove icon** (only while it has one). The image follows the profile photo's rules exactly
  (`prepareAvatar`): PNG, JPEG or WebP (never SVG), the first bytes must be that type, a square of 64–512 px, at most
  256 KiB, no animation, every metadata block cut out on the server; the browser cuts the centre square and scales it
  to 256 px first (`squarePhoto`). An emoji is exactly one, by the reaction rule (`isStatusEmoji`, one form).
- **Who:** exactly the settings' rule (`RoomApps.mine`, `mayManageApps`): in a team room or the everyone room its
  owners and admins who are in it, in a 1:1 or a group chat any of its members, never a guest; a member gets 403,
  anyone not in the room 404. The owner's words were "the person who added it and owners/admins"; following the
  existing settings permission exactly, a group chat's other members may change it too, as they may rename it. The
  image is served to anyone in the room (guests too: they see the messages), 404 to everyone else.
- **Storage:** `room_app_icons` (migration 356, C's range as asked): one row per app, an image or an emoji and a version
  that only grows (the avatar's millisecond clock), so `GET /api/rooms/:id/apps/:appId/icon?v=<version>` is cached for
  a year and a new icon is a new address. The image goes out with the profile photo's image-only headers (`nosniff`,
  `default-src 'none'; sandbox`, inline). `ON DELETE CASCADE` from `room_apps`: removing the app, or its room, removes
  the icon. No user column, so account removal does not change (who changed it is in the audit log,
  `room_app.icon`).
- **Where it shows:** the app's messages (`RoomAppRef.icon`) carry the live app's icon, so past messages show a new one
  too (the name stays what it was when posted); a removed app's messages show its letter. The person who changed it
  sees the room update at once; other open windows on the room's next read (no realtime event).
- **Not included (owner decision 3):** an icon or a name from the webhook payload. Slack's `username`, `icon_url`,
  `icon_emoji` and Discord's `avatar_url` are ignored, as before (a test sends them), because a message could pass for
  a person or another app.
- **Tests:** `tests/unit/b-room-apps-icon.test.ts` (who, the image rules, the emoji rule, presets refused, the payload
  fields, cleanup with the app and the room, cache headers, the audit), `web/test/e2e/room-apps-icon.spec.ts` (letters
  and tints, the three actions, a refusal, who sees the menu, 1440 and 390), screenshots in
  `web/test/e2e/shots-room-apps-icon.spec.ts`.
- **Version impact:** minor (a new setting, four endpoints, one additive migration).
