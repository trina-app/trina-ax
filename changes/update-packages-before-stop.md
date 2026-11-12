- Linux: `install-linux.sh update` and `repair` now download and install the headless browser, the Google Workspace
  library and the engines named with `--engine` while the team server keeps running, and stop it only to switch
  versions. Before, the server was down while they downloaded. In a test update from 0.4.0 the server was down for
  22 seconds before the change and 3 seconds after it, on a fast network. On a slow one the wait was longer, because the
  browser download alone may take up to 8 minutes. The install guide now says how long an update can take.
