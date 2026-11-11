# Google apps: how the server runs the library

Gmail, Google Calendar, Google Docs and Google Sheets get their tools from the Google Workspace MCP library
([github.com/taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp), MIT), a Python
program. This page is for administrators and developers: where it is installed, how the server starts it, and what to
check when the cards say the apps are not available. What people see and how they connect is in
[GOOGLE-APPS.md](GOOGLE-APPS.md).

## Where it is installed

- **Linux servers** (a self-hosted install, the hosted team image, the Docker image): in a Python venv of its own,
  `/opt/trina/python/workspace-mcp/<version>-<sha12>/`, with a link `current`. The server runs
  `/opt/trina/python/workspace-mcp/current/bin/workspace-mcp`. The folder belongs to root; the server's account only
  reads and runs it.
- **The Mac app**: not in this version. The cards say the apps are not available on this computer.

The version and every file it installs are pinned in the one list of system packages,
[`scripts/system/packages.json`](../scripts/system/packages.json) (`"python"`, and the `google-apps` group):

- the group `google-apps` (`install: default`) brings `python3` (3.11 or later: Debian 12 has 3.11, Ubuntu 24.04 3.12,
  Debian 13 3.13) and `python3-venv` from apt;
- `python.workspace-mcp` names the version, the Python it needs, the program, and each wheel as `name==version` with the
  sha256 of every file pip may take for it (CPython 3.11 to 3.13, Linux amd64 and arm64, glibc or pure Python).

`scripts/system/packages.sh` (`pk_python_install`) makes the venv with the system's `python3 -m venv` and runs
`pip install --require-hashes --only-binary=:all: --no-deps --isolated --no-cache-dir --index-url=https://pypi.org/simple`
with only those lines: no other version, no source build, no dependency pip would choose itself, no pip configuration
of the machine. The folder is named after the requirements' sha256, so a changed wheel is a new folder; `current` moves
to it only when its program starts (`workspace-mcp --help`); the folder before stays until the next switch, as a running
server may still use it.

Who installs it:

| Path | When |
| --- | --- |
| `scripts/install-linux.sh install` / `repair` | every install without `--minimal`; a failure only warns |
| `mycel-ctl update` (`packages.sh sync`) | when the list in `root/` changed, and again after some hours when it failed |
| The hosted image (`scripts/image/customize.sh`) | through the installer, as a self-hosted install |
| `docker/Dockerfile` | at build time, by default (when the kit's list has the group) |

To check a server: Admin › System › Diagnostics says where the sync of the list stands (`root/packages.synced`), and
`ls -l /opt/trina/python/workspace-mcp/` shows the venvs. `sudo ./install-linux.sh repair` from the kit tries again.

## How the server runs it

`server/src/integrations/google-apps/library.ts` starts it as a child process while at least one Google app is set up
on the server, and stops it when none is (and when the server stops). It runs as the server's account with:

- `--transport streamable-http --tools gmail calendar docs sheets --tool-tier complete --disabled-tools
  manage_document_comment manage_spreadsheet_comment`: the four apps, all their tools, minus the two comment tools that
  need full Drive access;
- `WORKSPACE_MCP_HOST=127.0.0.1` and a free port the server picked (`PORT`): nothing outside this machine can reach
  it. The server sends each call there with the person's Google access token; nothing a person types can name that
  address;
- `MCP_ENABLE_OAUTH21`, `EXTERNAL_OAUTH21_PROVIDER`, `WORKSPACE_MCP_STATELESS_MODE`: it keeps no sign-in, no session and
  no file; it checks each token with Google and uses it for that call only. The token check is not cached
  (`WORKSPACE_MCP_TOKEN_VALIDATION_CACHE_TTL` unset), so a sign-in a person removes stops working at once;
- `WORKSPACE_MCP_DISABLE_LOCAL_FILES=true`: it reads no file on the server;
- `GOOGLE_OAUTH_CLIENT_ID` of a configured Google app, and no client secret: a random
  `FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY` per start instead (the library needs one; nothing is signed with it in
  this mode);
- `HOME`, `TMPDIR` and `WORKSPACE_ATTACHMENT_DIR` in a private folder (0700) made for that start and removed when it
  ends;
- of the server's own environment only `PATH`, `LANG`, `LC_ALL`, the proxy variables and `SSL_CERT_FILE` /
  `SSL_CERT_DIR`. No secret of the server's, no telemetry (`OTEL_*`).

It is ready when `GET /health` answers. While it runs the server asks again every 15 seconds; three missed answers in a
row, or the process ending, make it **down**: it is stopped and started again after 2 seconds, then 4, 8 … at most
5 minutes between tries. Meanwhile the AI is told the app is not reachable, and the rest of the server works as before.
It uses about 150 MB of memory.

For tests and development: `MYCEL_GOOGLE_APPS_LIBRARY_URL=http://127.0.0.1:<port>/mcp` makes the server use that address
(a fake MCP server) and start nothing; `MYCEL_GOOGLE_APPS_LIBRARY_BIN=<venv>/bin/workspace-mcp` runs a venv of one's own
(any system, a Mac too).

## A new version

1. The tag's commit: `gh api repos/taylorwilsdon/google_workspace_mcp/tags`.
2. Its lock and the release's PyPI data:
   `gh api "repos/taylorwilsdon/google_workspace_mcp/contents/uv.lock?ref=<commit>" -H "Accept: application/vnd.github.raw" > uv.lock`,
   `curl -s https://pypi.org/pypi/workspace-mcp/<version>/json > pypi.json`.
3. `bun scripts/system/python-lock.ts workspace-mcp <version> uv.lock pypi.json` writes the version and the wheels into
   the list. It stops when a dependency has no wheel for one of the list's systems, when the dependencies differ between
   them, or when a pin is below the release's own requirement. Update the commit in the entry's `for`.
4. Check the tool names the server lists per app (`catalog.ts`) against the new version's `core/tool_tiers.yaml`, and
   read its changes for new environment settings.
5. `bun test tests/unit/system-packages.test.ts tests/unit/c-google-apps-library.test.ts`. A changed list is a root
   update ([RELEASE-CI.md](RELEASE-CI.md)).
