- Settings › Apps sends Mac users to the Mac App Store only: when the edition has a Mac App Store listing, the Mac row
  no longer offers the team server's unsigned installer file (no "Download the installer" fold), also inside the
  desktop app installed from such a file. Windows, iPhone and Android are unchanged; a build without a Mac App Store
  listing still offers the server's installer.
- A team's address on the relay no longer tells signed-out visitors whether the team has finished first-run setup:
  `GET /api/setup` says setup is needed there only to a visitor with the setup token (the setup link sends it), and
  wrong tokens count toward the same per-address limit as on `POST /api/setup`. This server and the office network see
  the real answer as before.
- The user guide's Mac install section now describes the App Store app.
