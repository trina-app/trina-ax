- Linux servers: before every answer, Trina now checks that the AI engine's network protection is really in place,
  not only that it was turned on earlier. If another program removed it (for example a firewall or Docker reload), the
  answer does not start and the chat says "The server's network protection is off" instead of "The answer stopped
  partway". The protection is put back automatically within 30 seconds (it was 2 minutes).
- Admin › System › Health shows the firewall as a problem while the protection is off, and `sudo mycel-ctl status`
  checks the rules the server holds right now.
