# Documents in the Docker install

- Date: 2026-11-24
- Status: accepted
- Supersedes: none (fills the Docker row of docs/decisions/20261124-doc-skills.md, which said "No (no run)")
- Branch: feat/doc-kit-docker (plan docs/AGENTS/plan/20261124-0554-doc-kit-docker.md; the owner's decisions 2 and 4 of
  docs/AGENTS/plan/20261124-0314-doc-quality-all-situations.md)

- **Ask.** Owner: the same document quality in Docker as on a hosted server, by one structural path, no tuning.
- **Rule.** The default image carries the run kit and LibreOffice. The AI builds documents in an srt run that the
  server starts with no systemd (`MYCEL_DEV_ENV_SRT_DIRECT=1`), and the server draws the pages in the converter
  isolation, as everywhere else.
- **Kit.** `install-srt.sh --image-mode --documents` from the kit's root copy, in `docker/Dockerfile`: the groups
  core, media, fonts and the new `docrun` (the run's Python libraries, socat, ripgrep, xz-utils, qpdf, zip, the
  python-pptx venv), node, srt, the node libraries and run-wrap. `docrun` was split out of `devenv`, so a default
  install keeps exactly what it had and the image leaves out the build tools, git, pip and chromium. The image also
  takes the `office-view` group (LibreOffice, Carlito, Caladea) and the fonts group; the render finds the kit fonts
  through fontconfig, so `MYCEL_KIT_FONTS_DIR` stays a Mac setting.
- **Offline, one at a time, by root.** The entrypoint writes `<base>/root/dev-env.json` at every start (root, 0644):
  plan `docker`, `network` offline, `maxRunning` 1, 1024 MiB and 512 processes per run. The server reads it and cannot
  change it (plan.ts), so no team setting turns the network on in a container.
- **Server account, not `axagent`.** The parent plan named `axagent`. A run uses the server account, as a run on a
  hosted server does (`trina-dev@.service` `User=`): the server cannot start a process as another account in the
  container (`no-new-privileges`, no capabilities), the launcher starts only engines inside the turn sandbox, which
  forbids the nested user namespace srt needs, and a run reads and writes the person's team folders, which belong to
  the server account. The walls are srt's: bubblewrap with every namespace, its seccomp filter (no AF_UNIX), the
  network namespace with srt's proxy allowing no host, `<base>` and `/etc/default/<id>` hidden. Running runs as
  `axagent` would need a root helper and a second owner for team files: reopen when the security review asks for it.
- **No cgroup per run** (limits reworked after the security review of #511). The server holds the run's limits:
  - every 500 ms, the resident memory and count of the run's whole process tree from `/proc` (bwrap starts new
    sessions, so the process group alone misses commands), against the plan's 1024 MiB and 512 processes;
  - the container's own `memory.current` against `memory.max` less 768 MiB: it counts what a process's resident memory
    does not (srt's tmpfs `/tmp` and `/run`, page cache). One run builds at a time, so the growth is that run's;
  - RLIMIT_NPROC as a hard process cap (per account: the account's tasks at the start plus the plan's 512);
  - nice 19 and SCHED_IDLE: a run never takes CPU from the server or a turn (the review measured 40-100x slowdowns
    without);
  - oom_score_adj: srt's node and run-wrap 700, the run's commands 1000, so the container's OOM killer takes the
    command and srt lives;
  - every process the watch has seen is remembered with its start time; when the run ends, however it ends (the review
    OOM-killed srt's node and run-wrap exited 137 while the sandboxed shell went on), what is left of them and below them
    is killed until nothing is. At start, a server kills what an earlier one left: processes of its account in another
    pid namespace, or run-wrap, srt or bwrap, that are not its own or its parents'.
  A run over a limit, or one the container's OOM killer hit, ends as "ran out of memory". Renders and prints go one at a
  time (`MYCEL_RENDER_PARALLEL=1`). The compose limits are the backstop.
- **Self-test.** With no systemd the runner checks that one command runs in srt here (offline, `<base>` hidden). Where
  it cannot (a host missing the guide's security settings, an Ubuntu host's AppArmor), box_shell is not offered and
  the AI uses make_file, as on any server without runs.
- **Which teams.** The same rules as every install with `MYCEL_DEV_ENV=1`: a team with no saved setting gets the dev
  environment's default (on), an older team that never chose gets documents mode
  (docs/decisions/20261124-documents-mode.md: work folder only), and a team whose admin saved it off gets neither. In
  Docker every one of them is offline, by the root plan file. Admins turn it off in the team settings; the operator
  turns AI commands off for the whole server with `TRINA_AX_DEV_ENV=0` in the compose environment.
- **Not changed.** The engine (as `axagent`, behind the firewall), the converters, the Office safety check (#499).
- **Version impact.** minor. A root update (the package list).
