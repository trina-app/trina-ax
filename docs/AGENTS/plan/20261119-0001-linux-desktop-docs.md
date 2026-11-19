# Linux desktop app (3/3): README, the install guide and the website line

- Date (UTC): 2026-11-19 00:01
- Branch: `docs/linux-desktop-docs`
- Status: done
- Where: trina-ax `README*.md`, `docs/INSTALL-LINUX*.md`; the download page in `trina-app/trina-ax-website`. Why: the
  README and the guides live here, the website in its own repository (see docs/REPOSITORY-RULES.md)
- Version impact: none (docs)

## Goal

Part 3 of [docs/decisions/20261119-linux-desktop-app.md](../../decisions/20261119-linux-desktop-app.md) ("Website and
README"): developers find the Linux app.

## Scope

In:
- README in every language it has (en, ko, ja, es, zh-CN): "Apps" and "Every device" name Linux, one small line under
  the download buttons, no new badge picture.
- `docs/INSTALL-LINUX.en.md` and `.md`: "Desktop app on Linux": which file, FUSE, sandbox, keyring, uninstall,
  checking `SHA256SUMS.sig`.
- The website (trina-app/trina-ax-website PR #20): one small Linux line under the Mac and Windows buttons, hidden until
  a release has the four files.

Out: a README in Indonesian (there is none today); a third download button.

## Steps

1. READMEs. 2. Install guide (English and Korean). 3. Website line, checked at 390 px in light and dark.

## Decisions

None new.

## Result

README lines in the five READMEs; the install guide section in both languages; the website line in
trina-app/trina-ax-website#20 (merges separately; nothing shows until a release carries the Linux files).
