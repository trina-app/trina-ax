- **Linux servers: AI answers work again after an automatic app update.** When a server updated itself (0.5.6 or 0.5.7
  taken as an app update), the new version's folder could only be read by the server account. The AI sandbox runs as
  another account, so every answer stopped after about half a second with "The answer stopped partway". The server now
  sets the right permissions when it unpacks an update, and on start it repairs version folders an earlier update left
  like this. A server broken on 0.5.7 heals itself when it starts 0.5.8. `sudo mycel-ctl update` and the installer were
  not affected. Until then, `sudo chmod -R o+rX /var/lib/mycel/app/versions/<version>` fixes a server by hand.
