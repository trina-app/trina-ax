# Chrome extension: a meaningful default name for each browser profile

- Date (UTC): 2026-11-28 18:55
- Branch: `feat/chrome-default-browser-name`
- Status: in progress
- Where: chrome-extension/ (popup, pairing), server/src/chrome/store.ts (redeem). Why: the in-profile Connect names
  every profile "Chrome on Mac", so a person with several profiles sees identical rows in Settings › Browser and the AI
  cannot tell them apart.
- Version impact: patch (server: a repeated name gets a number; extension 0.3.x patch: the name defaults to the
  profile's Google account, no new install warning)

## Goal

Owner feedback: "이 브라우저 이름을 지가 모르나? 구글 계정으로 하면 될 것 같은데". The Connect field should give a
meaningful name with no typing.

## Scope

In:
- The name field starts empty with the hint "This profile's Google account" (or holds the email when the extension can
  already read it). Left empty, Connect asks Chrome once, in the same prompt as the team address, for the optional
  `identity.email` permission and names the profile after its Google account
  (`chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })`, so a profile signed in without sync counts too).
  The email also goes to the server's existing `email` field (Settings › Browser and the AI already show it).
- `identity` becomes a required permission (no install warning: measured with
  `chrome.management.getPermissionWarningsByManifest` in Chrome 158), `identity.email` optional (no install warning;
  its prompt "Know your email address" shows only at the Connect click).
- Said no once: later Connects ask only for the team address (never a loop of prompts).
- No Google account (or no permission): "Chrome on Mac". The server numbers a name the person already uses for another
  profile ("Chrome on Mac 2"), so two rows are never identical, for every way of linking.
- Popup copy in plain 해요체 and the same meaning in all six languages ("이 브라우저를 팀에 연결해요", "팀 페이지를 먼저
  열어 주세요…").

Out: reading the Chrome profile's own name (no extension API; the desktop app's native helper cannot tell which profile
called it, so matching Local State is guesswork).

## Steps

1. Manifest: `identity` in permissions, `identity.email` in optional_permissions; types in chrome.d.ts.
2. Worker: `profileEmail()`; popup status carries it; pairing keeps it and sends it at redeem; an empty name resolves to
   the email, else the browser label.
3. Popup: empty field with the hint; Connect asks origins + identity.email once; storage flag after asking.
4. Server: redeemCode numbers a label that repeats one of the person's other links.
5. Messages in six languages; tests (unit for label numbering and messages); `bun run chrome:bump patch`.
6. Manual check in real Chrome 158 with throwaway profiles; screenshots in the scratchpad.

## Decisions

docs/decisions/20261128-chrome-default-browser-name.md (supersedes the "never the account's email" line of
docs/decisions/20261128-chrome-app-led-linking.md for the in-profile Connect only).

## Risks

- The email becomes the profile's name, so it shows where the name shows: the person's own Settings and AI, and the ask
  card in a chat (a shared chat shows it to its members). The person sees it in the field before connecting and can
  type another name.
- Chrome remembers a granted optional permission; removing it in chrome://extensions just makes the name fall back.
- Edge/Brave: `getProfileUserInfo` may return nothing; the fallback applies.

## Tests

- tests/unit: label numbering at redeem, message keys in six languages, popup/pairing helpers.
- Real Chrome 158: prompt text, granted/denied paths, two throwaway profiles get distinct names.

## Result

(filled in at the end)
