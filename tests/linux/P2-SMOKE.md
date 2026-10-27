# P2 Linux + Claude smoke

This is an explicit, potentially billable integration run on a **new disposable test host**. Ordinary `bun test` only exercises doubles and local fixtures. No live request is enabled by importing the harness or by its default `check` command. The current local development environment has not executed this procedure.

The harness runs the reviewed source API/AuthService/ChatRuntime/TurnExec with installed native gate/bridge, installed Claude and the installed external launcher. It uses `app.fetch` and the real Hub with an in-memory connection. It does **not** prove the compiled server bundle, browser, HTTP/WebSocket transport, or the older Stage1/Codex L25/T3 suite. Keep those gates separate.

## Prerequisites and provenance

- A working Linux ARM64 or x64 host, systemd, and the installer's real firewall/UID/bwrap/Landlock/seccomp/cgroup checks. Record their actual outputs separately, redacting secrets. Cross compilation and unit tests are not Linux evidence.
- Obtain approval for the actual cloud resources, duration/cost and test connection before provisioning or using it. For this project use AWS profile `trina`, Seoul; do not substitute another account or an existing customer installation.
- Build the kit and prepare `/opt/p2-src` from the same reviewed main+cloud tree plus the installed-mode guard, Linux socket-group fix and these smoke files. Deliver source and locked dependencies without Git history, `.env`, HOME, credentials, real databases, customer documents or `.validation` logs. Scan the artifact before delivery.
- Record SHA-256 of the delivered source/dependency archive and kit before upload. Verify both on the host, extract source/dependencies as root under `/opt/p2-src`, and make them read-only to the server account. Run the locked Bun dependency installation before enabling the live provider path. The root marker validates the installed bundle and engine; it does **not** bind imported source to that bundle. The delivery digest/build record supplies that separate evidence. Do not edit files after recording it.
- For root attestation, place the same pinned Bun at `/opt/p2-tools/bun`, with root-owned non-writable parents and binary, and record/verify its digest. Never execute the server-owned `app/current/bin/bun` as root. Worker commands below use that installed binary only as the unprivileged server account.
- Use only the fixed instance ID `mycel-p2-smoke`, new system accounts `p2server` / `p2agent`, and `/var/lib/mycel-p2-smoke`. Preflight requires system UIDs 100–999, separate groups, no supplementary groups, and the installer's fixed paths. No production service or database is eligible.

## Prepare the dedicated installation

Install with the reviewed kit, Claude only, no direct TLS, and `--no-auto-update`:

```sh
sudo /opt/p2-kit/install-linux.sh install --from /opt/p2-kit \
  --id mycel-p2-smoke --server-user p2server --agent-user p2agent \
  --engine claude --no-auto-update --allow-unsigned
sudo systemctl stop mycel-p2-smoke-server.service
```

`--allow-unsigned` is for this explicitly reviewed test kit. The installer has no `--no-start`: it starts server and launcher. Stop the **test server** promptly after installation; leave its launcher and firewall running. Do not use the container-only `--no-systemd` to claim a systemd test. If any users, team files, credentials or sessions have been created, discard the test host; the harness never erases them to manufacture a fresh state.

With only the dedicated server stopped, set these fields in its existing `config/server.json`, preserving owner `p2server:p2server` and mode `0600`: `relay={url:null,teamName:null,officialAvailable:false}`, `tunnel=null`, `update.auto=false`, `engine.codexBin=""`. Retain the installer's fixed Claude, launcher, proxy and agent paths. No upstream override is accepted. Check rejects unexpected metadata or configuration rather than repairing it.

Place the **explicitly designated test connection** at `/var/lib/mycel-p2-smoke/secrets/p2-claude.json`, owned by `p2server:p2server`, mode `0400` or `0600`, one hard link, no symlink. Transfer from an approved protected file; never pass a token in argv, user-data, shell history, SSM command text or chat. Supported JSON shapes are `{kind:"anthropic-api-key",key:…}` or `{kind:"anthropic-oauth",token:…,expiresAt:…}`. OAuth expiry must be known and more than 15 minutes away. The preparation stage performs no provider verification request; it stores one encrypted personal Alice credential, initially unchecked. It never imports a developer login.

## Explicit execution

Set nonsecret shell variables `P2_RUN_ID` (a new UUID), `P2_EXPIRES_AT` (ISO UTC timestamp within two hours and beyond the total deadline), and `P2_MODEL` (the explicitly approved Claude model). No budget has an automatic default. Proposed limits below are **20 provider HTTP admissions including count_tokens/retries, 6 engine attempts, 6 engine turns per attempt, 120 seconds per turn and 15 minutes total**; obtain approval for the actual values before using them.

Run from `/opt/p2-src`, with `env -i` **before Bun** and `--no-env-file --no-install`. In-process environment clearing cannot undo a preload already executed by Bun.

```sh
sudo env -i PATH=/usr/bin:/bin \
  /opt/p2-tools/bun --no-env-file --no-install \
  /opt/p2-src/tests/linux/p2-smoke.ts attest \
  --run-id "$P2_RUN_ID" --expires-at "$P2_EXPIRES_AT" --model "$P2_MODEL" \
  --server-user p2server --agent-user p2agent \
  --provider-requests 20 --engine-attempts 6 --tool-turns 6 \
  --turn-timeout-ms 120000 --total-timeout-ms 900000

sudo runuser -u p2server -- env -i PATH=/usr/bin:/bin \
  /var/lib/mycel-p2-smoke/app/current/bin/bun --no-env-file --no-install \
  /opt/p2-src/tests/linux/p2-smoke.ts check

sudo systemd-run --unit=mycel-p2-smoke-worker --wait --collect --pipe \
  --uid=p2server --gid=p2server --working-directory=/opt/p2-src \
  --property=RuntimeMaxSec=960 --property=TimeoutStopSec=30 --property=KillMode=control-group \
  /usr/bin/env -i PATH=/usr/bin:/bin \
  /var/lib/mycel-p2-smoke/app/current/bin/bun --no-env-file --no-install \
  /opt/p2-src/tests/linux/p2-smoke.ts execute \
  --run-id "$P2_RUN_ID" --provider-requests 20
```

The worker verifies that only its server is inactive and its launcher active. It does not stop or restart services. Root attestation inspects the engine-owned private home without giving the worker access to it. This is a dated root observation, not a live worker inspection.

The execution receipt is created exclusively **before** reading the credential or seeding data. Every admission is appended and fsynced before use. An existing receipt, including a failed or interrupted run, rejects every retry. Never remove the receipt or reuse the instance to reset the request limit. Its `.json` filename contains newline-delimited JSON records; parse it line by line. Fixture usernames/passwords stay in memory, passwords are hashed, and initial output placeholders allow real pre-write file-version assertions.

L1 requires streamed successful Claude output and proxy usage. L2 requires successful read/write audits, file content, version and event evidence. L3 requires an actual denied read and checks the synthetic private canary is absent from exposed results. L4 creates one future once schedule via the model tool, waits for the real scheduler, and checks Alice ownership, the same credential, file evidence and no duplicate execution. A refused model tool action, limit hit or failed cleanup is a failed/incomplete run, never an automatic retry or limit increase.

## Results and teardown

Only the allowlisted JSON report, durable receipt, artifact hashes and sanitized host evidence are result artifacts. Never collect the credential file, vault keys, database, prompts, response bodies, session transcripts or raw environment. Unit test success is not a substitute for this report and host probes.

Cleanup closes admissions, deletes schedules, cancels pending/running test turns, revokes proxy tokens, waits for engine handles and closes context. Any unproven cleanup state fails the report. If context closure is unproven, the CLI leaves its DB handle intact and forces a failed worker exit within one second after writing the failed receipt/report; it does not claim cleanup succeeded. The transient systemd unit additionally bounds the process group if startup or cleanup hangs; native engine timeouts are separate. A startup failure may precede registration of all product closers, so verify the worker cgroup is empty and the launcher is idle after failure; never call that failure a successful smoke.

Keep the dedicated test server stopped during artifact collection and teardown. Do not restart it with a failed receipt or pending work. Terminate the disposable cloud instance and delete its scoped resources according to the approved AWS runbook; stopping a service or host does not end storage billing. Verify resource deletion independently. Preserve failed evidence and use a newly approved fresh instance for any later attempt.
