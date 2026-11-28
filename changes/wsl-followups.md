- Windows PC (WSL) servers: the installer's last lines now say to open http://127.0.0.1:47820/setup on this PC, with
  the setup code on the clipboard or shown by `wsl -d TrinaAX --cd / -u root -- cat /var/lib/mycel/setup/code`,
  instead of an ssh tunnel and `sudo cat`.
- Windows PC (WSL) servers: Admin › System › Connection names the mode without the relay **This PC only** (not
  "Office network only"), and says in one line that other computers on the office network cannot reach a WSL server.
- Admin › System › Connected folders says "Folder path on this computer", with a Linux example, on a Linux or WSL
  server; "this Mac" and the Finder examples stay on a Mac. In all six languages.
- The Windows setup window no longer fills with apt's output ("Reading database … 5%"): it goes to
  /var/log/trina-packages-apt.log, the window shows the "still installing" lines, and a failure names the log and its
  last lines.
- Windows setup: when installing Debian stops on a new PC (wsl.exe exit code -1), the script tries once more by itself,
  after removing the half-made distro it left; if that fails too, it says to run the script again.
