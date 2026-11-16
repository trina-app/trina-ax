- **Linux servers: AI answers work again after an automatic app update.** When a server updated itself (0.5.6 or 0.5.7
  taken as an app update), the new version's folder could only be read by the server account. The AI sandbox runs as
  another account, so every answer stopped after about half a second with "The answer stopped partway". The server now
  sets the right permissions when it unpacks an update, and on start it repairs version folders an earlier update left
  like this, before it answers anything. A server broken on 0.5.7 heals itself when it starts the next version (0.5.9).
  `sudo mycel-ctl update` was not affected; `install-linux.sh repair` now also fixes the modes of the version it copies.
  Until then, `sudo chmod -R o+rX /var/lib/mycel/app/versions/<version>` fixes a server by hand.
