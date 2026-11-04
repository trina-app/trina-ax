# Dev environment on srt (design)

Status: built behind `MYCEL_DEV_ENV_RUNNER=srt` on branch `feat/srt-dev-env` (2026-11-04). The box stays the default.
Section 12 lists what the build changed from this design and what is not done.

Decision (owner and Dion, 2026-11-04): the dev environment drops the podman box (`mycel-boxd`). The AI's commands run
directly on the team server inside Anthropic's sandbox runtime **srt** (npm `@anthropic-ai/sandbox-runtime`,
Apache-2.0), in a `systemd-run --scope` unit for CPU, memory and pids limits. Claude Code and Codex use the same Trina
tool. Heavy jobs wait in a queue. They are not refused. Proposal: https://claude.ai/artifact/78Kprci28nUSm3dkUnLBek

Scope change (owner, 2026-11-04, overrides the rest of this design where they differ): the dev environment is **not
locked to a project**. Any chat, with or without a project, can run commands. A command's sandbox follows the **person
who owns the chat**: it may read and write exactly the team folders that person (and their AI) may open now, under the
folder rules (read-only where the person reads only), plus the chat's own work folder for a chat with no project, plus
a home per person for caches. The queue and the limits are per team, not per project. Section 0 has the details.

Rule for this design: keep it simple. Each fallback gets one line.

## 0. The sandbox follows the person (scope change)

### 0.1 Who may run commands

- One setting for the team (`devEnv.team`, admins): `enabled`, `scope` (everyone, or selected groups and people),
  `network`, `limits`, `consent` (to warning version 2), and `extraDomains`. The per-project setting
  (`devEnv.project.<id>`) stays for the box runner only. On srt the project page shows the team setting, and its
  settings modal saves the team setting (`PUT /api/admin/dev-env`).
- `mayUseDevEnv(person)` (`server/src/devenv/setting.ts`): the flag, the team setting on with a consent to version 2,
  an active account, and the person in scope. The turn offers `box_shell` in every chat of such a person, also a chat
  with no project. It is never offered in a scheduled run, an approved template run or a confidential chat (no change).
- The tool checks `mayUseDevEnv` again on every call.

### 0.2 What a run may open (`server/src/devenv/srt/access.ts`)

The folder rules (`policy/access.ts`, `RuleSet.access`) are the only source. The same function decides what the
person and their AI may open in the file tools.

- Access changes only at a folder with rules. So the candidates are the team root, every rule folder, `users/`,
  `users/<me>` and `.system/`. Each candidate gets `RuleSet.access` for the person.
- An entry is written only where the access differs from the nearest candidate above it:

  | Access here | Access above | srt entry |
  |---|---|---|
  | read | none | `allowRead` |
  | write | none or read | `allowWrite` |
  | read | write | `denyWrite` |
  | none | read or write | `denyRead` |

- srt applies the entries shallowest first (a tmpfs on a denied folder, the allowed folders inside it bound back, then
  a deeper tmpfs). So the deepest entry decides, as in the rules. A unit test checks a model of this against
  `RuleSet.access` on the fixture and on 200 random rule trees. The Docker attack suite checks the real srt.
- One case is stricter than the rules: write below a read-only folder below a write folder. srt's `denyWrite` wins
  over an `allowWrite` inside it, so that folder is read-only in a run (fail closed).
- Fixed, whatever the rules say: `users/` is hidden as a whole (it would list everyone's personal folder names), and
  the person's own `users/<id>` is writable again. Other people's personal folders stay hidden, for owners and admins
  too. `.system/` is hidden.
- Only folders that exist go into the settings (srt skips the others).
- The runner builds the entries again for every command and every job start. The tracker builds them again every 10 s
  for each person with a running job or dev server. When the hash of the entries changes (a rule, a group, a new rule
  folder on disk) or the person may no longer use the dev environment, it stops those runs with reason `setting`.

### 0.3 Where a run starts (its root)

- A project chat whose project has its own folder that the person can read: the project folder. The run gets a change
  window there (`track.ts`, as before): file events, versions, conflict copies, "changed by other people" and the
  credential-command gate.
- Any other chat (no project, a project on the team root, or a project folder the person cannot open): the chat's
  work folder `<base>/devenv/work/<chatId>` (server-owned, 0700). The server removes it when the chat is purged
  (`chat/forget.ts`). The file tools do not show it: the AI copies a result into a team folder the person can write.
  Nothing there is recorded as a team file change.
- The engine's own working folder (`<agent root>/<chatId>`) is not used: it belongs to the engine account (0700), and
  srt runs as the server account.

### 0.4 Per person, per chat, per team

| Thing | Key |
|---|---|
| HOME, TMPDIR, caches (`<base>/devenv/home/<userId>`) | person |
| logs, command output, exit files (`<base>/devenv/logs/<userId>`, `$TRINA_LOGS`) | person: another person's job log can hold text from folders this person cannot open |
| log names of jobs and dev servers | person |
| waiting jobs: at most 3 | person |
| one foreground command at a time | root folder (the change window needs it) |
| one dev server | chat |
| job results to the AI (`runResultsForAI`) | the chat that started the job, once |
| job notices (live and inbox) | the person who started the job; the link goes to the chat |
| `maxRunning`, `maxRunning + 1` commands, at most 10 waiting, FIFO queue, the devenv slice | team (the server) |

- The first call of a turn in a project chat names other people's jobs and dev servers in that project: kind, name
  and who, never logs.
- New API: `GET /api/dev-env/runs` and `POST /api/dev-env/runs/:runId/stop` (the caller's own runs, from every chat).
  The project page lists the runs of the project's chats.
- The environment adds `TRINA_TEAM` (the team folder: team paths of the file tools are under it) and, for the work
  folder, `TRINA_WORK`.

### 0.5 DB

Migration `222_b_dev_env_run_state.sql` (unmerged, so it was rewritten in place) makes a new table `dev_env_runs`:
`dev_env_jobs` needs a project (`project_id NOT NULL` with a foreign key) and tables are never rebuilt. `dev_env_jobs`
stays as it is for the box. A row has `user_id`, `chat_id`, `project_id` (null: no project), `root`, `cwd`, `kind`,
`state`, `unit`, `access` (the hash of 0.2) and the end fields. The inbox reads both tables for `dev_env.job` (a job
of a chat with no project has `projectId` and `projectName` `''`).

### 0.6 Known gaps of the scope change

These are open (Q0 in section 11):

- **Writes outside the root are not recorded.** A command can write every folder the person may write. Only the
  project folder has a change window. Writes elsewhere get no `file_events`, no older versions (no undo after
  `rm -rf`) and no conflict copies. The file service's own versions do not see them.
- **The read-scope check is bypassed.** The file tools ask before they save content into a folder that more people can
  see (`chat/read-scope.ts`). A command can `cp groups/finance/x shared/` with no question.
- A folder made during a long run by someone else, in a folder the run can read, is visible until the next tracker
  poll (at most 10 s) stops the run.
- Server temp files (`.mycel-tmp-*`) in a folder the person can write are visible to the run. srt has no way to hide a
  name pattern at any depth.
- One person's runs share their home and logs: a job can read the output of the same person's other jobs.

Until Q0 is answered, do not call this safe for production teams with private group folders.

## 1. Goals and limits

The server is one team per EC2 VM. srt must protect these from the AI's commands:

- the Trina server process, its port and its sockets;
- the Trina DB and every file under the base folder (`/var/lib/<ID>`), the secrets and the engine logins;
- the server's environment (`/etc/default/<ID>` and the values the unit loads);
- the folders that the person of the chat may not open, and other people's personal folders, logs and homes.

The AI may:

- read and write the team folders that the person of the chat may open (section 0), read-only where the person reads
  only;
- read system tools (node, python3, ffmpeg, chromium, git, ...) but not change them;
- reach the network only through srt's proxy, and only to allowed domains.

When memory is full, the kernel kills the job. It never kills the Trina server. The Starter plan (4 GB, 2 vCPU) must
fit: on Starter, one heavy job runs at a time.

Out of scope: protection from a compromised Trina server. The server sets the limits for its own jobs. A root-owned
slice (section 4) gives a hard ceiling that the server cannot raise.

## 2. Executor

### 2.1 Who runs what

- The server account runs srt. It is not the engine account: the engine runs in the launcher's bwrap with no shell and
  cannot exec other programs (`native/cmd/mycel-launcher/sandbox_linux.go`). `box_shell` already runs in the server
  process.
- Files that the AI writes belong to the server account, the same as files from the file tools. There is no uid
  mapping.
- srt runs in **CLI mode**, one srt process for each command, job or dev server. Library mode is not used. Reasons:
  - Library mode has one config for each process (a singleton). CLI mode gives each project its own settings file.
  - In library mode the proxies live in the server process, so a server restart cuts the network of all jobs. In CLI
    mode the proxies live in the srt process, inside the job's scope. A server restart or update does not stop jobs.
- The srt CLI runs under the system node (version 22.12 or later). It does not run under Bun.

### 2.2 The call

For each run the server spawns this (one argv, no shell):

```
systemd-run --scope --quiet --collect
  --unit=trina-dev-<runId>.scope --slice=<ID>-devenv.slice
  -p MemoryMax=<m> -p MemoryHigh=<0.9 m> -p MemorySwapMax=0 -p CPUQuota=<c*100>% -p TasksMax=<pids>
  -p OOMPolicy=kill -p RuntimeMaxSec=<limit>
  -- /opt/trina/devenv/run-wrap <exit-file>
  -- /opt/trina/node/bin/node /opt/trina/srt/0.0.81/cli.js --settings <settings-file> -c <command>
```

- `<runId>`: a random id, 16 lowercase characters. The unit name is the only thing the polkit rule checks.
- `--collect`: systemd removes the unit after the end, also after a failure.
- `run-wrap` is a short root-owned shell script. A scope has no exec properties (no LimitFSIZE, no OOMScoreAdjust, no
  WorkingDirectory, no Environment), so the wrapper does these steps:
  1. set rlimits: file size 4 GiB, open files 4096, core 0;
  2. write 800 to `/proc/self/oom_score_adj`, so the kernel picks the job before the server when the whole machine is
     short of memory;
  3. run the rest of the argv;
  4. write the exit code to `<exit-file>`.
- The server sets the cwd (the project folder, or a subfolder from `cwd` after the existing `boxCwd` check) and the
  environment (2.4).
- stdin is `/dev/null`. stdout and stderr go to log files that the server opens (section 6). They never go to a pipe:
  a pipe breaks when the server restarts.

### 2.3 Permission to make scopes (polkit)

The server account has no capabilities and no user manager (`server.service.in`). systemd starts a transient unit only
after polkit says yes. The install adds one rule (polkitd, JavaScript rules):

```js
// Trina dev environment: the server account may start and stop its own job scopes, nothing else.
polkit.addRule(function (action, subject) {
  if (action.id !== "org.freedesktop.systemd1.manage-units" || subject.user !== "@SRV_USER@") return;
  var unit = action.lookup("unit") || "", verb = action.lookup("verb") || "";
  if (/^trina-dev-[a-z0-9]{16}\.scope$/.test(unit) && (verb === "start" || verb === "stop")) return polkit.Result.YES;
});
```

- The rule allows only `.scope` names. A transient `.service` can set `User=root`, so the rule must never allow one.
- A scope does not change the uid. The command runs as the server account.
- The job stays in the server's mount namespace: ProtectSystem=strict, ProtectHome=yes and PrivateTmp also apply to
  the job. This is good (less to see), but it has two effects:
  - every folder that the job or the server writes must be in `ReadWritePaths` of `server.service.in` (section 9);
  - `/tmp` is the server's private `/tmp`. The settings deny it (2.5).
- Spike check S1: StartTransientUnit gives `unit` and `verb` to polkit, and systemd moves a pid out of the server's
  delegated cgroup into the scope.
- Fallback (one line): with no polkit, put jobs in a delegated leaf `S/devenv` with `mycel-sandbox cgexec`
  (`server/src/system/cgroups.ts`). The cost: jobs die when the server restarts.

### 2.4 Environment

srt gives its caller's environment to the command (it has no `--clearenv`). The server spawns systemd-run with an
explicit environment and nothing from `process.env`:

```
PATH=/opt/trina/node/bin:/usr/local/bin:/usr/bin:/bin
HOME=<base>/devenv/home/<userId>
TMPDIR=<base>/devenv/home/<userId>/tmp
LANG=C.UTF-8  TERM=dumb  CI=1  SHELL=/bin/bash
npm_config_cache=$HOME/.npm  PIP_CACHE_DIR=$HOME/.cache/pip  PLAYWRIGHT_BROWSERS_PATH=0
TRINA_LOGS=<base>/devenv/logs/<userId>
TRINA_TEAM=<team folder>  TRINA_WORK=<base>/devenv/work/<chatId> (a chat with no project only)
```

srt then adds HTTP_PROXY, HTTPS_PROXY, ALL_PROXY and GIT_SSH_COMMAND. There is no MYCEL_* variable and no value from
`/etc/default/<ID>`. An attack test checks this (A3).

### 2.5 srt settings file (per run)

The server writes `<base>/devenv/run/<runId>.json` (mode 0600) before the spawn and deletes it after the end. The
sandbox cannot read this folder. Example for alice (member of marketing) in a project chat (section 0 gives the
filesystem lists; the example is before the scope change, for the network part):

```json
{
  "filesystem": {
    "denyRead": ["/var/lib/<ID>", "/etc/default/<ID>", "/tmp", "/var/log", "/run", "/home", "/root"],
    "allowRead": ["<project folder>", "/var/lib/<ID>/devenv/home/p1", "/var/lib/<ID>/devenv/logs/p1"],
    "allowWrite": ["<project folder>", "/var/lib/<ID>/devenv/home/p1"],
    "denyWrite": []
  },
  "network": {
    "allowedDomains": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "github.com", "..."],
    "deniedDomains": ["<team host name>", "<other Trina host names>"],
    "deniedResolvedAddresses": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
      "169.254.0.0/16", "fc00::/7", "fe80::/10", "<this VM's public IPs>"],
    "allowLocalBinding": true,
    "strictAllowlist": true
  },
  "mandatoryDenySearchDepth": 3
}
```

Rules:

- **Deny the whole base folder**, not a list of subfolders. srt hides only paths that exist when it starts. A file
  that appears later in a denied folder is hidden, because the folder itself is hidden. `allowRead` wins over
  `denyRead`, so only the three named folders come back. The base holds the DB, `secrets`, `config`, the engine
  logins (`agent/codex-auth`), the server's home (`data`) and the other project folders.
- `/etc/default/<ID>` is the only server file outside the base. If the install adds more files outside the base, it
  must add them here. A unit test checks the list against the install script.
- The logs folder is readable (the AI runs `tail` on its own logs) but not writable. The AI cannot forge an exit code
  or another job's log.
- `allowWrite` holds only team folders the person may write (never `.system/`, never another person's `users/<id>`),
  the person's home and the chat's work folder. `settingsProblems` refuses anything else before each spawn.
- srt also denies writes to `.git/hooks`, `.git/config`, `.gitmodules`, `.vscode`, `.idea`, shell rc files and
  `.mcp.json` in the project. Keep this: it protects people who later run git in the folder on their own computer.
- An offline project gets `"allowedDomains": []`. srt then still makes a private network with no route out.
- The public IPs come from IMDS when the server starts and again before each run. An EC2 instance without an Elastic
  IP can get a new address after a stop.
- The settings file is complete for each run. srt treats a bad or empty file as an error, so a bug fails closed.

### 2.6 Timeouts and stop

- A foreground command: `timeout_sec` (default 120, at most 1800). At the limit the server runs
  `systemctl stop trina-dev-<runId>.scope` (SIGTERM, then SIGKILL after 5 s). `RuntimeMaxSec` is the limit plus 30 s,
  as a backstop when the server is down.
- A job: at most 6 hours (`RuntimeMaxSec`).
- A dev server: see section 5.
- bwrap runs with `--die-with-parent --unshare-pid`. When srt ends, every child ends, also a `setsid nohup ... &`.
- Each stop gets an end reason: `exit`, `timeout`, `oom`, `stopped` (a person), `idle`, `disk`, `setting` (the project
  setting changed or the person lost write access), `lost` (the scope is gone and there is no exit file).

### 2.7 One run, step by step (foreground)

1. The checks in `tool.ts`: `mayUseDevEnv`, the root (0.3), the credential-command gate (project folder only),
   `boxCwd`, the storage floor.
2. The server takes the root folder's lock (one foreground command at a time for each root).
3. It writes the settings file and opens `out.log` and `err.log` in the run folder.
4. It builds the folder access (0.2) and spawns systemd-run, inside `withChangeWindow` for a project folder.
5. On exit it reads the exit file and `memory.events` of the scope (`oom_kill` > 0 means `oom`).
6. It returns the first 32 KiB of stdout and of stderr, the exit code and the end reason, as today.
7. It writes the audit row `dev_env.command` (no change).

## 3. Settings per team and per project

### 3.1 Per project (box only after the scope change)

After the scope change srt reads `enabled`, `scope`, `network`, `limits` and `consent` from the team setting (0.1).
The text below now applies to those team fields. `devEnv.project.<id>` stays as it is for the box
(`shared/src/api/dev-env.ts`):

- `enabled`, `scope`, `consent`: no change.
- `network`: `open` now means "the allowlist" (defaults plus team additions). It no longer means the whole internet.
  `offline` means no network. The warning text changes, so `DEV_ENV_WARNING_VERSION` goes up by one and owners accept
  again.
- `limits.cpus`, `memoryMiB`, `pids`: the project's wish, cut to the plan caps (section 4).
- `limits.idleStopMin`: now the idle stop of dev servers (section 5).
- `limits.diskGiB`: no meaning now. Keep it in the schema so that old rows parse, and hide it in the UI.

### 3.2 Per team (new key `devEnv.team`, admins only)

```ts
DevEnvTeamSetting = { extraDomains: string[] /* at most 50 */, enabled, scope, network, limits, consent }  // 0.1
```

Domain rules for an admin addition:

- a lowercase host name with at least two labels, or `*.` followed by one;
- no IP address, no `*` alone, no `*.com`-style public suffix (check against a short built-in list);
- not a Trina host name of this team.

The default list lives in code (`shared/src/dev-env-domains.ts`) and changes only with a release:

- npm: `registry.npmjs.org`, `registry.yarnpkg.com`
- Python: `pypi.org`, `files.pythonhosted.org`
- GitHub: `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`
- Others to decide (Q4): `deb.nodesource.com`, `cdn.jsdelivr.net`, `unpkg.com`, the Playwright and Remotion download
  hosts, `crates.io`, `proxy.golang.org`.

Known limit: an allowed domain can carry data out (for example a gist on github.com). The warning text says so.

### 3.3 Folder rules (summary)

| Path | Read | Write |
|---|---|---|
| Team folders the person may write (from the rules, 0.2) | yes | yes (minus srt's fixed write denies) |
| Team folders the person may read only | yes | no |
| Team folders the person may not open, `users/<other>`, `.system/` | no | no |
| The chat's work folder `<base>/devenv/work/<chatId>` (a chat with no project) | yes | yes |
| `<base>/devenv/home/<person>` (HOME, TMPDIR, caches) | yes | yes |
| `<base>/devenv/logs/<person>` | yes | no |
| The rest of `<base>` (DB, secrets, config, other people's homes and logs, other chats' work folders, engine files) | no | no |
| `/etc/default/<ID>`, `/tmp`, `/run`, `/var/log`, `/home`, `/root` | no | no |
| `/usr`, `/opt/trina` (node, srt, chromium, ...), the rest of `/etc` | yes | no |

node_modules and `.venv` are now in the project folder and use team disk. `snapshot.ts` already skips them.

## 4. Resource limits and the queue

### 4.1 Plan caps

The source stays `<base>/root/dev-env.json` (root-owned, format 1, from PR #58). Keep the keys as they are, so that a
server with the box still reads the same file during the move:

| Key | Meaning with srt |
|---|---|
| `maxRunning` | jobs that run at the same time, and dev servers at the same time |
| `memoryMiB` | the memory of the whole devenv slice, and the maximum for one run |
| `cpus` | the CPU of the whole slice, and the maximum for one run |
| `pids` | the maximum tasks for one run |
| `network` | `offline` forces every project offline |
| `diskGiB` | not used |

- The server reads the file with a TS port of `parseEntitlement` (`native/cmd/mycel-boxd/plan.go`), with the same
  ranges. An unknown key or a bad value is an error: the dev environment is then not available (fail closed).
- The install writes `/etc/systemd/system/<ID>-devenv.slice` from the same file, as root: `MemoryMax=memoryMiB`,
  `CPUQuota=cpus*100%`, `TasksMax=pids*(2*maxRunning+2)`. The name makes it a child of `<ID>.slice`. The server
  cannot raise these values.
- Self-hosted servers have no file. Then the fixed ranges and the project setting apply.

Proposed numbers (Q1, measure in the spike first):

| Plan (machine) | memoryMiB | cpus | pids | maxRunning |
|---|---|---|---|---|
| Starter (4 GB, 2 vCPU) | 1536 | 1.5 | 512 | 1 |
| 8 GB, 2 vCPU | 3584 | 1.5 | 1024 | 2 |
| 16 GB, 4 vCPU | 8192 | 3 | 2048 | 3 |

On Starter this leaves about 2.4 GB for the OS, the server, engine turns and converters. Each srt process (node and
its two proxies) uses about 60 MiB. That memory counts in the job's scope.

### 4.2 Run kinds and queue rules

| Kind | Tool call | Queue | Limit |
|---|---|---|---|
| command | `box_shell` (default) | no queue | one per root folder; at most `maxRunning + 1` on the server |
| job | `job=true` | **yes** | `maxRunning` on the server |
| dev server | `background=true` | no queue | `maxRunning` on the server; one per chat |

- A command over the server limit is refused at once with a clear message ("the dev environment is busy, try again in
  a minute"). A short foreground command must not wait in a queue behind a render (Q3).
- A job over the limit gets state `waiting`. The call returns at once: "queued, position N". FIFO for the whole server.
- At most 3 waiting jobs for each person and 10 for the server. Past that, the call is refused.
- A waiting job ends with reason `expired` after 24 hours.
- When a slot is free (end event, or the 10 s tracker), the oldest job starts. Before the start the server checks
  `mayUseDevEnv` and the folder access (0.2) for the person again. If it fails, the job ends with reason `setting`
  and a notice.
- A dev server over the limit is refused. The message names the running dev servers, so the AI or the person can stop
  one.
- Memory full: each scope has `memory.oom.group` (OOMPolicy=kill). The kernel kills the whole run in the scope where
  memory ran out. When the whole slice is full, the kernel kills a run in the slice. The server is outside the slice.
  The end reason is `oom`, and the person gets a notice.
- Disk: while runs are active the tracker checks the storage floor every 10 s (the floor in `tool.ts` today). Under
  the floor it stops all runs with reason `disk`.

### 4.3 DB change (additive migration `NNN_b_dev_env_run_state.sql`, reader 1)

Replaced by the table `dev_env_runs` of 0.5. The text below is the first design.

```sql
ALTER TABLE dev_env_jobs ADD COLUMN state TEXT NOT NULL DEFAULT 'running'
  CHECK(state IN ('waiting','running','ended'));
ALTER TABLE dev_env_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'job' CHECK(kind IN ('job','server'));
ALTER TABLE dev_env_jobs ADD COLUMN run_at TEXT;          -- when it left the queue; started_at = when it was asked for
ALTER TABLE dev_env_jobs ADD COLUMN cwd TEXT NOT NULL DEFAULT '';
ALTER TABLE dev_env_jobs ADD COLUMN unit TEXT NOT NULL DEFAULT '';
ALTER TABLE dev_env_jobs ADD COLUMN end_reason TEXT NOT NULL DEFAULT '';
CREATE INDEX dev_env_jobs_waiting ON dev_env_jobs(started_at) WHERE state = 'waiting';
```

- Dev servers get rows with `kind='server'`. The server finds them again after a restart.
- An older build sees a waiting row as running (`ended_at IS NULL`). This is harmless: the older build has no runner.
- Stop notices stay in `dev_env_stops` with new codes: `oom`, `disk`, `idle`, `timeout`, `expired`, `setting`, `lost`.
  `dev_env_notices.event_type` keeps its two values (`dev_env.job`, `dev_env.box`). No CHECK change.

## 5. Long-running dev servers

- Each dev server is its own srt run in its own scope, with no time limit of its own.
- Each srt run has its own network namespace and pid space. **A later command cannot reach the dev server.** The tool
  text tells the AI to test in one command: `npm run dev & sleep 5; curl -s localhost:3000; kill %1`.
- Idle stop: the tracker stops a dev server after `idleStopMin` (default 30) with no preview request and less than 2 %
  CPU (from `cpu.stat` of the scope). Reason `idle`, no notice.
- Maximum life: 8 hours (`RuntimeMaxSec`). Reason `timeout`.
- A change of the team setting (network, limits, turned off) stops all runs. Reason `setting`.
- **Preview.** The dev server listens on 127.0.0.1 in its private namespace. srt has no way in, and its seccomp filter
  blocks AF_UNIX in the sandbox. New path: a `mycel-sandbox port-forward` subcommand (Go, about 100 lines):
  1. it enters the user namespace of the run's bwrap process (the server account owns it, so it gets the capabilities
     there);
  2. it enters the network namespace;
  3. it connects to `127.0.0.1:<port>` and serves it on a unix socket in `<base>/devenv/run/<runId>-<port>.sock`.

  `preview.ts:113` uses this socket in place of `boxd().preview()`. The rest of the preview gateway (tokens, cookies,
  access checks) does not change. Spike check S2: setns works under NoNewPrivileges and the server unit's mount
  rules.
- Fallback (one line): v1 ships with no preview, and the AI tests with curl in one command (Q2).

## 6. Output, logs and the jobs list

- Run folder: `<base>/devenv/logs/<userId>/`. The server owns it. The sandbox of that person's runs can only read it.
  - command: `cmd-<runId>.out` and `cmd-<runId>.err`; the server deletes them after it has read them;
  - job or dev server: `<log_name>.log` (stdout and stderr together), kept 7 days, at most 64 MiB (the tracker cuts
    the start of the file);
  - exit file: `<runId>.exit`, written by `run-wrap`.
- The AI reads progress with `tail -n 20 $TRINA_LOGS/<log_name>.log`.
- Jobs list (`jobs.ts`):
  - `pollJobs` no longer asks boxd. It reads the DB rows with `state='running'`, then for each one the scope
    (`systemctl show -p ActiveState,MemoryCurrent`), the exit file and the last line of the log.
  - `endJob`, `jobResultsForAI` and the notices stay.
  - `pollStops` reads the end reasons in place of boxd status.
  - After a restart, `startJobTracker` matches the `trina-dev-*.scope` units against the DB rows. A unit with no row
    is stopped. A row with no unit and no exit file ends with `lost`.
- Process list (`ps`): the pids in the scope's `cgroup.procs` and their `/proc/<pid>/cmdline`.
- Network log: srt blocks a request and writes a line to stderr. v1 counts the blocked host names from the log files.
  It does not show every destination as conntrack did. The audit row keeps the allowlist that applied.

## 7. Move from the box

- A new environment variable `MYCEL_DEV_ENV_RUNNER=srt|box`. The default is `box` until the srt install is in the team
  image. `MYCEL_DEV_ENV=1` stays the master flag.
- A `DevEnvRunner` interface in `server/src/devenv/runner.ts`: `available`, `run`, `start`, `stop`, `list`,
  `previewSocket`. `boxd.ts` gets a thin adapter for it. `srt.ts` is the new runner. Tests use a fake runner (the
  same way `setBoxdClient` works today).
- The tool name stays `box_shell` in v1. A rename touches `engine/claude.ts:130`, `engine/codex.ts:197`,
  `chat/subagents.ts:27` and `shared/src/step-labels.ts`. It is a separate change.
- New tool text: `SRT_SHELL_DESCRIPTION` in `server/src/devenv/tool.ts` (after the scope change it says that the
  command has the folder access of the person of the chat, where it starts, `$TRINA_TEAM` and `$TRINA_WORK`). First
  draft:

  > Run a shell command in the dev environment of this project (bash, git, node, npm, python3, pip, ffmpeg,
  > chromium). The command runs in the project folder on the team server. Changes are shared with the team and
  > recorded with your name. node_modules, .venv and build output are in the project folder and use team disk. The
  > network reaches only allowed sites (npm, PyPI, GitHub and the sites an admin added), or nothing (the project
  > setting). There are NO credentials: git push, npm publish and other commands that need a login do not work. You
  > cannot change .git/config or .git/hooks. For a dev server use background=true; the person opens it with the
  > Preview button. A later command cannot reach it: to test it, start it, call it and stop it in one command. For a
  > long command (a render, a large build) use job=true; if other jobs run, it waits in a queue. Read its log with
  > tail -n 20 $TRINA_LOGS/<log_name>.log and do not wait in a loop. One command at a time per project; default time
  > limit 120 s; only the first 32 KiB of stdout and of stderr come back.

- `chromium`: the namespace sandbox of chromium fails inside srt. Use `--no-sandbox --disable-dev-shm-usage`. Do not
  set `allowNestedUserNamespaces`: it turns off srt's write denies.
- Order of PRs:
  1. this design;
  2. the srt runner behind the flag, the migration, unit tests and attack tests;
  3. install and team image (section 9);
  4. UI and i18n (section 8);
  5. **a separate PR later** removes the box: `native/cmd/mycel-boxd/`, `server/src/devenv/boxd.ts`, the Boxd* wire
     types, the box parts of `scripts/dev-env/`, the boxd parts of `native/build.sh`, `scripts/build-bundle.ts`,
     `scripts/install-linux.sh` and `native/cmd/mycel-ctl/update.go`, the matching test lines, and the box parts of
     `docs/DECISIONS.md` and `docs/INSTALL-LINUX.md`.
- Existing projects keep their setting key. The warning version goes up, so an owner accepts the new network meaning
  before the first srt run.

## 8. UI changes

- `web/src/pages/DevEnvSection.tsx`:
  - remove the box state (none, stopped, running), box memory, Stop box, Restart box and the disk and busy_max stop
    codes;
  - add **Running now**: the command, job or dev server, who started it, memory, run time, the last log line, and a
    Stop button for each one;
  - add **Waiting**: position, who, the command name, and a Cancel button for the person who asked and for owners and
    admins;
  - the settings modal: remove disk size; label the idle stop as "Stop an unused dev server after N min"; network
    choices "Allowed sites only" and "No network", with the list of allowed sites (read only);
  - a stop message for each new end reason (`oom`, `disk`, `idle`, `timeout`, `expired`, `setting`, `lost`).
- Admin settings: a new "Dev environment" block with the team's extra domains (add and remove, the rules of 3.2) and
  the plan caps (read only).
- Notifications: new texts for the stop codes in `notifications/service.ts` and `Notifications.tsx`.
- i18n: the `devEnv.*` keys in `web/src/i18n/{en,ko,id,ja,es}.ts`.
- `web/test/mock/server.ts` and `web/test/e2e/project-page.spec.ts`: the new shapes (running list, waiting list, team
  domains).
- API: `DevEnvBox` is replaced by `DevEnvRuns { running: DevEnvRun[], waiting: DevEnvRun[] }`. New routes:
  `POST /api/projects/:id/dev-env/runs/:runId/stop` and `GET|PUT /api/admin/dev-env` (team domains).

## 9. Install (team image / AMI)

Packages (Debian 13):

- already there: `bubblewrap` (≥ 0.8.0), `nftables`, `git`;
- new: `socat`, `ripgrep`, `polkitd`, `python3`, `python3-venv`, `python3-pip`, `ffmpeg`, `chromium`,
  `build-essential` (native npm modules), `fonts-noto-cjk`;
- node: Debian 13 has node 20, and srt needs 22.12 or later. Install the official node 22 LTS tarball into
  `/opt/trina/node` with a pinned SHA-256.

srt:

- `scripts/dev-env/srt/package.json` and `package-lock.json` pin `@anthropic-ai/sandbox-runtime@0.0.81` and its
  dependencies with integrity hashes.
- The install runs `npm ci --ignore-scripts` into `/opt/trina/srt/0.0.81`, root-owned, mode 0755. A link `cli.js`
  points to the CLI.
- Check that `vendor/seccomp/<arch>/apply-seccomp` exists for the machine's arch.
- A new srt version goes into a new folder. Running scopes keep the old folder. The update removes an old folder only
  when no scope uses it.
- srt is outside every writable path. It is never in a project's node_modules.

System files written by the install (root):

- `/opt/trina/devenv/run-wrap` (0755);
- `/etc/polkit-1/rules.d/60-<ID>-devenv.rules` (2.3);
- `/etc/systemd/system/<ID>-devenv.slice` (4.1);
- `server.service.in`: add `@BASE@/devenv` to `ReadWritePaths`; add `MYCEL_DEV_ENV=1` and
  `MYCEL_DEV_ENV_RUNNER=srt` in the existing drop-in;
- `scripts/linux/deps.txt`: add socat, ripgrep and polkitd;
- Ubuntu 24.04 only: an AppArmor profile that gives userns to `apply-seccomp`, as `apparmor-bwrap.in` does for bwrap.
  Debian 13 needs none.

At start the server runs srt's dependency check (bwrap, socat, rg, seccomp) and the polkit test (start and stop an
empty scope). If one fails, availability is `{ available: false, reason: 'platform', detail }`.

## 10. Tests

### 10.1 Unit (`tests/unit/dev-env-srt.test.ts`, fake runner and fake systemd)

- folder access: `folderView` against `RuleSet.access` (the fixture table and 200 random rule trees), the fixed hides
  of `users/` and `.system/`;
- settings file: deny the whole base, the person's folders, home and logs, offline means `allowedDomains: []`, public IPs in
  `deniedResolvedAddresses`, team domains added, bad domains refused;
- the server-file list matches what `scripts/install-linux.sh` writes outside the base;
- environment: only the listed keys; nothing from `process.env`;
- argv: the unit name matches the polkit pattern; limits are cut to the plan caps;
- `dev-env.json` TS parser: the same cases as `plan_test.go`;
- queue: FIFO across people and chats, limits per person and per server, refused past the limit, `expired` after
  24 h, the access check at start, a running job stopped when the person's access changes;
- a project chat, a chat with no project (the work folder), a person who reads the project only, a person who cannot
  open the project folder; results only to the chat that started the job;
- end reasons: exit, timeout, oom (from `memory.events`), stopped, idle, disk, setting, lost;
- restart: units and DB rows are matched again; an orphan unit is stopped;
- the existing `dev-env.test.ts`, `dev-env-jobs.test.ts` and `project-trash-state.test.ts` pass with the fake
  runner.

### 10.2 Attack suite (`tests/linux/srt-attack.sh`, same style as `tests/linux/attack.sh`)

The driver puts canary strings in the denied places, then runs each line as a `box_shell` command. A line passes when
no canary comes back and the action fails.

| # | Attack | Expected |
|---|---|---|
| A1 | read `<base>/data/*.db`, `secrets/*`, `config/*`, `agent/codex-auth/*` | not found |
| A2 | read a folder the person may not open (another group, another project, a hidden folder inside her group), another person's `users/<id>`, `.system/`; list `<base>/team`, `team/users` | not found |
| A2b | another chat's work folder, another person's logs and home | not found |
| A2c | write into a folder the person reads only (a read-only folder inside her project, `skills/`) | read-only |
| A3 | `env`; `cat /proc/self/environ` | no MYCEL_*, no canary from `/etc/default/<ID>` |
| A4 | read `/etc/default/<ID>`, the server's `/tmp`, `/run/<ID>` | not found |
| A5 | a canary file made in `<base>/secrets` after the run started | not found |
| A6 | write to `/usr/local/bin`, `/opt/trina/srt`, `$TRINA_LOGS`, another project's home | read-only |
| A7 | write the own exit file or a settings file in `<base>/devenv/run` | fails |
| A8 | write `.git/hooks/pre-commit`, `.git/config` in the project | fails |
| A9 | a symlink or hard link in the project to a denied file, then read it | fails |
| A10 | a `cwd` through a symlink out of the project folder | refused before the run |
| A11 | `curl` with no proxy; raw TCP; `dig @8.8.8.8`; UDP | no network |
| A12 | through the proxy to a domain not on the list | blocked |
| A13 | to 169.254.169.254, 10.x, a 100.64/10 tailnet IP, the VM's public IP, a name that resolves to 127.0.0.1 | blocked |
| A14 | to the Trina server port and its host name | blocked |
| A15 | `git clone ssh://` to a host not on the list | blocked |
| A16 | connect to `/run/dbus/system_bus_socket` and the server's tools socket | AF_UNIX denied |
| A17 | `systemd-run`, `systemctl stop` of another unit, from the sandbox | fails |
| A18 | `ps`, `kill -9` of the server pid, ptrace | the server is not visible; ESRCH |
| A19 | `unshare -U`, `mount`, `chroot` | fails |
| A20 | `setsid nohup sleep 9999 &`, then the command ends | the sleep is gone |
| A21 | a memory bomb as a job | the job ends `oom`; the server `/health` answers 200 |
| A22 | a fork bomb | stopped at TasksMax; the server answers |
| A23 | `dd` in the project folder up to the disk floor | the run stops with `disk` |
| A24 | chromium `--headless --no-sandbox` opens `file:///var/lib/<ID>/secrets/...` | not found |
| A25 | as the server account outside the sandbox: start `trina-dev-x.service` or `other.scope` | polkit says no |
| A26 | preview of job A's port through job B's socket; the sandbox opens a preview socket | fails |

CI: lines A1-A20 and A24 run in the existing Docker job (bwrap works there), with a delegated cgroup in place of
systemd. A21-A23, A25 and A26 need systemd and polkit, so they run on the spike VM (`scripts/dev-env/srt-vm-tests.sh`).

### 10.3 Spike VM (AWS)

- Only `--profile trina` (account 896568317806, region ap-northeast-2).
- One t3a.medium (the Starter size), Debian 13, tag `trina-test=srt-spike`.
- Do not touch `trina-cp-1`, `trina-relay-1`, `trina-ax-qa-1` or `pve-kr1-pilot`. Create no IAM users, roles or keys.
- Run the install, the attack suite and the checks in section 11. Measure memory with a real Next.js dev server and a
  Remotion render running together.
- Teardown: terminate the instance, delete its volumes and its security group. Prove it with
  `aws ec2 describe-instances` / `describe-volumes` / `describe-security-groups` filtered on the tag, all empty.

## 11. Open items

Spike checks:

- S1: StartTransientUnit gives `unit` and `verb` to polkit; systemd moves a pid out of the server's delegated cgroup
  into the scope; a scope accepts `OOMPolicy` and `RuntimeMaxSec` on the Debian 13 systemd.
- S2: `port-forward` (setns into the run's user and network namespaces) works under NoNewPrivileges.
- S3: srt start time with the ripgrep scan on a project with a large node_modules. If it is slow, set
  `mandatoryDenySearchDepth` lower or exclude node_modules.
- S4: chromium headless through the HTTP proxy, with `/dev/shm` or `--disable-dev-shm-usage`.
- S5: the real memory budget on Starter: the server, one engine turn, one converter and one heavy job.
- S6: Ubuntu 24.04 only: AppArmor and the nested namespace of `apply-seccomp`.
- S7: srt makes its proxy bridge sockets and temp files in `os.tmpdir()`, so they land in the project's TMPDIR, and
  bwrap binds them by path. Check that the `/tmp` deny does not hide them, and that a command cannot replace them.
- S8: srt 0.0.81 is a "beta research preview". Check the release notes before each version change.

Questions for the owner and Dion:

- **Q0 (scope change, first):** writes outside the project folder are not recorded and bypass the read-scope check
  (0.6). Options: (a) keep it, and say so in the warning (this build); (b) make every folder except the root and the
  person's own folder read-only in a run; (c) a change window over every folder the person may write (cost: a snapshot
  of those folders per command). (b) is one line in `access.ts` and is the safe default for teams with private group
  folders.
- Q1: the plan numbers in 4.1.
- Q2: can v1 ship without preview (curl in one command only), with preview in v1.1?
- Q3: a foreground command over the server limit: refuse at once (this design) or wait up to 60 s?
- Q4: the default domain list.
- Q5: a separate Linux account for jobs (stronger, but needs a root helper to switch uid) as a later step, or never?

## 12. Build notes (2026-11-04)

Scope change build (second commit set): `srt/access.ts` (folder access), the team setting and `mayUseDevEnv`
(`setting.ts`), the runner keyed by person, chat and root (`srt/runner.ts`), `dev_env_runs` (migration 222 rewritten),
the srt rows in `jobs.ts`, `tool.ts` (`srtCall`), the turn (`chat/turn.ts`: every chat), the routes (team setting,
the person's runs), the inbox (`notifications/service.ts`), the work folder's removal (`chat/forget.ts`), the project
page's modal (saves the team setting on srt) and the warning text (version 2, not yet accepted by any team).

Code: `server/src/devenv/srt/` (`config.ts` settings, environment and argv; `plan.ts`; `system.ts`; `runner.ts`), the
forks in `tool.ts`, `jobs.ts`, `setting.ts` and `routes/dev-env.ts`, migration `222_b_dev_env_run_state.sql`, install in
`scripts/dev-env/srt/`, tests in `tests/unit/dev-env-srt.test.ts` and `tests/linux/srt-attack.ts`.

What the build changed from this design:

- No `DevEnvRunner` interface and no boxd adapter (7). The srt code forks at the top of the box code: the removal PR then
  deletes the box branches, with no adapter to delete too.
- The install uses a drop-in (`ReadWritePaths=<base>/devenv`, the flags) and does not change `server.service.in` or
  `scripts/linux/deps.txt` (9). `install-srt.sh` installs the packages.
- The polkit rule also allows the verb `reset-failed`: a scope that the kernel killed for memory stays `failed` with
  `Result=oom-kill`, and the runner reads that result and then forgets the unit. There is no `--collect`.
- srt sets `TMPDIR` in the sandbox to `/tmp/claude`, which the settings hide. The run's environment sets
  `CLAUDE_CODE_TMPDIR` to the project home's `tmp`, so srt uses that folder.
- The settings deny the team folder too when it is outside the base folder. A check (`settingsProblems`) refuses a
  settings file that breaks the rules before each spawn.
- A `cwd` through a link out of the project folder is refused before the run (A10).
- The team's host names come from the public origins, the relay URL and `MYCEL_DEV_ENV_DENY_HOSTS`. They are denied in
  each run and refused as admin domains.
- The command of a waiting job is kept in `<base>/devenv/run/<row>.cmd` (0600). The row keeps the text with secrets
  hidden.
- The log of a job is cut to nothing at 64 MiB (not "cut the start").
- `MYCEL_DEV_ENV_SRT_DIRECT=1` runs srt with no scope (no limits): for Docker and development only.

Verified: the Docker attack suite (22 attacks, real srt 0.0.81, Debian 13, arm64) passes: A1-A16, A18-A20, offline,
and the positive checks (the project folder, an allowed site). The listing of `<base>/team` shows only the path to the
project folder (srt makes the parents of an allowed path).

Not done:

- Preview (S2, `port-forward`); the UI (running and waiting lists, the admin sites, the new stop texts) and i18n. The
  consent modal still shows the box warning text but sends version 2: do not turn srt on for a team before the UI PR.
- The tool rename; Ubuntu 24.04 (S6); the public IPv6 of the VM (IMDS gives only IPv4 here).
- Not verified on systemd: S1 (polkit gets `unit` and `verb`; a pid moves from the server's delegated cgroup), the scope
  limits, `Result=oom-kill`, RuntimeMaxSec, S5 (Starter memory), and attacks A17, A21-A26.
- The devenv slice is a child of `<ID>.slice`: when 1A limits are on, the runs share that ceiling with the server.

