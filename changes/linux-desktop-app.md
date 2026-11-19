- The desktop app now builds for Linux: a .deb for Ubuntu and Debian and an AppImage for other distributions, each
  for x64 and arm64. The .deb adds the app to the app grid and opens `trina-ax://` links. On a system where the
  AppImage cannot use the app's security sandbox (Ubuntu 24.04), it says to install the .deb and quits instead of
  running without it.
- Apps on your computer, on Linux: settings are saved only when the system has a keyring (GNOME Keyring or KWallet);
  without one the app says so instead of keeping them unprotected.
