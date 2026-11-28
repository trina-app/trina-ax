- **A Windows PC can be the team server.** `scripts/windows/install-wsl-server.ps1` sets up the normal Linux server
  inside WSL2 Debian on Windows 11 or Windows 10 22H2: it checks the PC (memory, virtualization, disk), turns on the
  WSL features (one restart, then it goes on by itself), installs Debian with systemd, downloads and checks the kit
  exactly as the Linux guide does, installs, keeps the server running while the Windows account is signed in, and asks
  before it turns off sleep. `-WhatIf` shows the changes first. Guide: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md)
  ([한국어](docs/INSTALL-WINDOWS.ko.md)).
- The Linux installer no longer warns that "every turn" will be refused on a kernel whose Landlock works but whose
  `/sys/kernel/security/lsm` it cannot read (WSL2, some containers and VMs): it asks the sandbox helper instead.
- The Linux installer says every minute that it is still installing packages; on a new server that step took several
  minutes without a line and looked hung.
- `mycel-ctl status` and Admin › System › Diagnostics show a Claude or ChatGPT connection that waits for its usage
  limit as a warning, also when another connection of the team is switched off; they said fail, while Admin ›
  Providers said limited.
