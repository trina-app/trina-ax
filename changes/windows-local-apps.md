- **Apps on your computer work on Windows.** A pasted Windows path such as `C:\Tools\server.exe` (or one with spaces) is
  kept as it is, and programs installed with npm (`npx …`, an npm-installed Aside) start instead of failing with "could
  not start". Only npm's own shims run without a shell; any other batch file runs only with values Windows' command
  prompt cannot misread.
- **A program that isn't installed no longer shows "Connected".** Connecting Aside, ego lite or any program that is not
  on the computer now says it isn't installed (with the Aside or ego lite download page) and asks nothing, so the chat
  no longer waits on it.
- **The desktop app's "Connect a program" window is easy to see.** The window comes forward and flashes, and the page
  says it is waiting for Connect there.
- ego lite is opened by itself on Windows too when it is closed.
