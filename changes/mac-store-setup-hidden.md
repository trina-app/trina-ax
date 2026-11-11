- Settings › Apps sends Mac users to the Mac App Store only: when the edition has a Mac App Store listing, the Mac row
  no longer offers the team server's unsigned installer file (no "Download the installer" fold), also inside the
  desktop app installed from such a file. Windows, iPhone and Android are unchanged; a build without a Mac App Store
  listing still offers the server's installer.
- A team's address on the relay no longer tells signed-out visitors whether the team has finished first-run setup:
  `GET /api/setup` says setup is needed there only to a visitor with the setup token (the setup link sends it), and
  wrong tokens count toward the same per-address limit as on `POST /api/setup`. This server and the office network see
  the real answer as before.
- The user guide's Mac install section now describes the App Store app.
- Through the relay, `POST /api/setup` checks the setup token before it looks at whether the team exists: a made-up
  token gets the same counted 403 before and after setup (it used to get a 409 "already set up" afterwards). This
  server and the office network keep the 409.
- Settings › Apps: on an office Mac server with a Mac App Store listing, the owner's hint names only the Windows
  installer to add.
