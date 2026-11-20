# Trina AX logo

The source of truth for the Trina AX logo and app icon. The website (ax.trina.app, `public/brand/`) and the Trina Cloud
console copy these files; change them here first. Decided by the owner on 2026-11-16: **the light version is the
primary logo, and the app icon is the light tile.**

## Files

| File | What | Use it on |
| --- | --- | --- |
| `mark-light.svg`, `mark-light-512.png`, `mark-light-1024.png` | The mark, **primary**: ink sides `#14110F`, Signal Orange top `#FF5B1F` | light and paper backgrounds |
| `mark-dark.svg`, `mark-dark-512.png`, `mark-dark-1024.png` | The mark for dark backgrounds: paper sides `#F6F2EA`, orange top `#FF6A33` | dark backgrounds only |
| `wordmark-light.svg`, `wordmark-light-512.png`, `wordmark-light-1024.png` | Mark + "Trina AX", **primary** | light backgrounds |
| `wordmark-dark.svg`, `wordmark-dark-512.png`, `wordmark-dark-1024.png` | Mark + "Trina AX" in paper | dark backgrounds only |
| `app-icon.svg` | The app icon: the light tile with corners and a hairline edge | tabs, docs, anywhere the icon is drawn with its corners |
| `app-icon-square.svg`, `app-icon-512.png`, `app-icon-1024.png` | The app icon full-bleed (the system cuts the corners) | App Store, Google Play (512 px store icon), stores |

PNGs have a transparent background (the app icon PNGs are the square tile). The wordmark's words are outlines of Geist
SemiBold (650) at the website nav's size and spacing, so no font is needed.

Every file, and the app icon pictures of the apps, are written by `make.py` (see its header for the command):
`web/public/favicon.svg`, `desktop/scripts/trina-icon.svg` → `desktop/build-resources/icon.png` (the `.icns` for the DMG
and the Mac App Store and the Windows `.ico`) and `desktop/build-resources/linux-icons/` (16…512 px, the Linux app), `../mobile/` (iOS icon, Android adaptive icon and its background,
launch screen in light and dark) and the Microsoft Store tiles. The web app's PNG icons and `favicon.ico` follow with
`bun web/scripts/make-icons.ts`.

## Rules

- **Primary is light.** Use `mark-light` / `wordmark-light` wherever the background is light. Use the dark version
  only on a dark background (dark theme, a dark photo, a dark slide). Never put the light mark on dark or the dark mark
  on light.
- **App icon = the light tile** (paper `#FBF9F4` → `#EFE9DE` from top to bottom, the light mark at 0.78 of the tile).
  The slight tone keeps it visible on a white home screen and in a store's grey list. There is no dark app icon: the
  iPhone's dark and tinted icon slots get the same light tile (else iOS darkens it into a black tile in notifications
  and the Dark home screen), and web push shows it too. The Android status bar icon stays a white silhouette and the
  Mac menu bar helper uses system symbols.
- **Clear space:** keep free space around the mark of at least a quarter of its height (8 units of its 32-unit box);
  around the wordmark, at least the mark's half-height.
- **Minimum size:** mark 16 px on screen (tab icons), wordmark 80 px wide; below that use the mark alone.
- **Colours:** ink `#14110F`, paper `#F6F2EA`, Signal Orange `#FF5B1F` (light) / `#FF6A33` (dark). In UI text and
  buttons the orange is `#E8521A` (contrast on paper); the mark keeps its own orange.
- **Don't:** recolour the mark or the top, outline it, add a shadow or glow, stretch or rotate it, put it in a tile of
  another colour, set "Trina AX" in another font next to it, or rebuild it from text and shapes. Use the files.
