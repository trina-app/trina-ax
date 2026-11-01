# Dev environment trial on one team server

Status: EXPERIMENT. The owner approved this for one server on 2026-11-01. It is not a release. The corrected flood and
process limit tests have not run in a real box yet (`docs/research/dev-env-test-vm-plan.md`), so use a project
with no secrets. Keep the commands in this order. Steps 3 and 4 restart the team server and end running answers, so
do them when nobody works.

The team VM must have at least 4 GB (the kernel shows about 3.8 GB; less than 3.5 GB is refused). A box can use 2.5 GB
and 1 CPU, which leaves about 1.3 GB for the server and the AI answers. If the server then runs short of memory, the
answers wait in the queue or stop. Watch `free -m` during the trial.

## 1. Build (not on the team server)

Needs bun, Go and about 3 minutes. Output: `dist/linux/`.

```bash
git checkout feat/dev-env && bun install --frozen-lockfile
ARCHS=amd64 bash native/build.sh
bun run build:web
bun scripts/build-bundle.ts --os linux --arch amd64 --version 0.2.17-devenv.1 --no-whisper --out dist/linux
```

- `--no-whisper`: voice input and the speech in video reads do not work on this build. To keep them, copy
  `whisper-cli*` from `/var/lib/mycel/app/versions/<current>/bin/` into a folder and use `--whisper-dir <folder>`
  in place of `--no-whisper`.
- The version must be higher than the feed's newest release. The kit has no signature, so the install needs
  `--allow-unsigned`, and `mycel-ctl update --bundle` refuses it.
- `mycel-boxd` is not in the kit. It is `native/bin/linux-amd64/mycel-boxd`.

## 2. Copy to the server and look first

Put the repo under `/opt` (the server account must read `scripts/dev-env/`), and `mycel-boxd` at `/opt/mycel-boxd`.

```bash
sudo cat /var/lib/mycel/root/install.json | tee ~/install-json-before-trial.json
```
```bash
sudo tar xzf TrinaAX-server-0.2.17-devenv.1-linux-amd64.tar.gz -C /opt/ && ls /opt/
```
```bash
cd /opt/TrinaAX-server-0.2.17-devenv.1-linux-amd64 && ./install-linux.sh check --from . --allow-unsigned
```

Keep `install-json-before-trial.json`: going back needs these arguments. Stop if `hosted` is true in it, or if `check`
reports a problem.

Make a database copy. The server also makes one before it applies migrations (`data/backups/`).

```bash
sudo systemctl stop mycel-server && sudo cp -a /var/lib/mycel/data/app.db /var/lib/mycel/data/app.db.before-trial && sudo systemctl start mycel-server
```

## 3. Install the build

```bash
cd /opt/TrinaAX-server-0.2.17-devenv.1-linux-amd64 && sudo ./install-linux.sh update --from . --allow-unsigned
```

The other arguments come from `root/install.json`. The old version stays for going back, and the server returns to it
by itself if the new one does not start. This also replaces the root programs (launcher, sandbox helper, `mycel-ctl`).

## 4. Install the dev environment

```bash
sudo /opt/trina-ax/scripts/dev-env/install-trial.sh --boxd /opt/mycel-boxd
```

It stops before it changes anything if the VM is too small, if the running version has no dev environment, or if
something of the same name is already there. It turns off `mycel-update.timer` (the daily update must not replace the
trial build) and reads the team root from `config/server.json`. Then, in the app: a project page, Dev environment, accept
the warning, turn it on. There is no preview domain, so the Preview button stays off.

Logs: `journalctl -u mycel-boxd -n 50`.

## 5. Remove it and go back

Remove the dev environment first. This restores the packages, the account and the timer. Project folders stay; box
volumes (`node_modules`, caches) go.

```bash
sudo /opt/trina-ax/scripts/dev-env/uninstall-trial.sh
```

**Go back: use this way.** In the app: Admin, System, Update, Roll back. The kept previous version runs again. The root
programs stay at the trial build, and `allowUnsigned` stays in `root/install.json`. The product's own roll-back works
this way, with newer root programs under an older server.

The older version can read the database: the new migrations are additive and the reader level did not change (4), so a
database restore is not necessary.

**Go back fully** (root programs too, and no `allowUnsigned`). Do this only if the root programs cause a problem. The
installer keeps root programs that are newer than the kit, so this needs an uninstall. `uninstall` without `--purge`
keeps the team folder, the data and the config, but it removes the engine account: the Claude token must be set again
(`set-claude-token`), and a Codex login stays only with `--keep-logins`. The server is down until the install ends.
Download the kit of the old release from its GitHub release, unpack it to `/opt/old-kit`, then use the arguments of
`install-json-before-trial.json` (for example `--public-host`):

```bash
cd /opt/old-kit && sudo ./install-linux.sh uninstall --keep-logins
```
```bash
cd /opt/old-kit && sudo ./install-linux.sh install --from . --engine claude --public-host <host>
```

Check after: `cat /var/lib/mycel/root/VERSION`, the app's version, `id mycel-devbox` (no such account),
`systemctl is-enabled mycel-update.timer`. `trina-tunnel` is not changed by any step.
