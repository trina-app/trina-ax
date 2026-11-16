# The light logo is the primary logo, and the app icon a light tile

- Date: 2026-11-16
- Status: accepted
- Supersedes: the warm-black tile as the app icon (docs/DESIGN-SYSTEM.md "Iconography and logo" before this change)
- Branch: brand/logo-light-primary (the owner)

- **Ask:** the owner compared the light and dark logo and chose the light one as the main logo ("밝은 거를 메인으로
  가자"), then asked for the app icons on the stores to change too.
- **Rule:** the logo's source of truth is `editions/trina/branding/logo/` (README there: files, when to use the dark
  version, clear space, minimum size, colours, don'ts). Light backgrounds take the light mark; dark backgrounds the dark
  mark. Every app icon (web tab and home screen, desktop on macOS and Windows, iPhone, Android, Microsoft Store) is the
  light tile, toned from `#FBF9F4` to `#EFE9DE` so it does not vanish on a white home screen; the rounded tile has a
  hairline edge (dropped where the system cuts the corners). The phone's launch screen is light, dark in dark mode.
- **Why:** one recognisable logo everywhere, matching the website, which already showed the light mark on light pages.
- **Left out:** store uploads happen with the next builds (phones 1.0.8, desktop 0.5.9; Google Play's 512 px store icon
  is uploaded in Play Console, `app-icon-512.png`). The notification icon and the Mac menu bar helper stay monochrome.
- **Version impact:** patch.
