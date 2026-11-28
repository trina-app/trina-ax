# A Chrome profile is named after its Google account

- Date: 2026-11-28
- Status: accepted
- Supersedes: the "never the account's email" line of 20261128-chrome-app-led-linking.md, for the in-profile Connect only
- Branch: feat/chrome-default-browser-name (owner feedback on the Connect popup)

- **Ask:** the Connect popup named every profile "Chrome on Mac"; with several profiles every row looked the same. The
  owner: "이 브라우저 이름을 지가 모르나? 구글 계정으로 하면 될 것 같은데".
- **Rule:** the name field starts with the profile's Google account when the extension may read it, else empty with the
  hint "This profile's Google account". Left empty, Connect asks Chrome in one prompt for the team address and the
  optional `identity.email` permission ("Know your email address"), once per install: after a Deny the next Connect asks
  only for the address. The email (`chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })`, so a profile signed
  in without sync counts) becomes the name and goes to the link's `email` field. No account or no permission: "Chrome on
  Mac". The server numbers a name the person already uses for another of their profiles ("Chrome on Mac 2"), for every
  way of linking (in-profile, desktop app). The person can type any name, and rename later.
- **Why optional:** a required `identity.email` adds "Know your email address" to the install prompt, and an update
  that adds a warning disables the extension until each person accepts it. Measured in Chrome 158
  (`chrome.management.getPermissionWarningsByManifest`): `identity` alone and `identity.email` as optional add no warning;
  the 0.3.2 manifest has the same four warnings as 0.3.1.
- **Left out:** the Chrome profile's own name ("Work"): no extension API gives it, and the desktop app's native helper
  cannot tell which profile is calling (matching Local State would be a guess). The desktop-app path keeps using it.
- **Privacy:** the email shows where the profile's name shows: the person's Settings › Browser, their AI, and the address
  card of a chat that uses the profile (members of a shared chat see that card). The person sees the email in the field
  before connecting and can type another name.
- **Version impact:** patch (extension 0.3.2; server: numbered repeated names).
