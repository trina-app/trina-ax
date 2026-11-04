# Dev environment trial on one team server

Status: EXPERIMENT. The owner approved this for one server on 2026-11-01. It is off by default, and a second team needs
the owner's approval. The flood and process limit tests ran in a real box on 2026-11-01 at 1 CPU and 2.5 GB: 67 PASS,
0 FAIL. Section 6 says what is still not tested. Use a project with no secrets.

The first run restarts the team server and ends running answers, so do it when nobody works.

The team VM must have at least 4 GB (the kernel shows about 3.8 GB; less than 3.5 GB is refused). A box can use 2.5 GB
and 1 CPU, which leaves about 1.3 GB for the server and the AI answers. If the server then runs short of memory, the
answers wait in the queue or stop. Watch `free -m` during the trial.

## 1. What is where

| Item | Path | Comes from |
|---|---|---|
| Root helper | `/var/lib/mycel/root/mycel-boxd` | the release kit, root-owned like `mycel-sandbox` |
| Service | `/etc/systemd/system/mycel-boxd.service` | `install-trial.sh` |
| Switch | `/etc/systemd/system/mycel-server.service.d/dev-env.conf` (`MYCEL_DEV_ENV=1`) | `install-trial.sh` |
| Box image | `localhost/mycel-devbox:1`, in the `mycel-devbox` account | `build-image.sh`, on this server |
| Seccomp profile | `/etc/mycel-boxd/box-seccomp.json` | `build-image.sh`, on this server |

Kits from this change on have `root/mycel-boxd`, also on a server without the dev environment. The file alone changes
nothing: the dev environment needs the service and the switch. `mycel-boxd` never runs from a version folder, because the server account
owns those folders and root must not run a program that account can change.

The kit has no box image. The server builds it.

## 2. Install on a signed release

The server must run a release whose kit has `root/mycel-boxd`. To update: `sudo mycel-ctl update`.

```bash
ls -l /var/lib/mycel/root/mycel-boxd
```

Put the repo under `/opt` (the server account must read `scripts/dev-env/`). Use the commit of the running release, or a
newer one. Run the script from any folder:

```bash
sudo /opt/trina-ax/scripts/dev-env/install-trial.sh
```

It needs `jq` (`sudo apt-get install -y jq`). It stops before it changes anything if this is a hosted server whose plan
does not include the dev environment (below), if the VM is too small, if the running version has no dev environment, if
root does not own `root/mycel-boxd`, or if something of the same name is already there and an earlier run did not make
it. It reads the team root from `config/server.json`, and
it stops if that path has a character other than letters, digits and `. _ / -`: the server account can change this file,
and root runs the unit with this value. It does not change `mycel-update.timer` on a signed release.

Then, in the app: a project page, Dev environment, accept the warning, turn it on. There is no preview domain, so the
Preview button stays off.

Logs: `journalctl -u mycel-boxd -n 50`.

A re-run is safe. It rebuilds the image, and a running box does not stop for that. It restarts `mycel-boxd` only if the
unit changed, or if the service runs a program other than the file `root/mycel-boxd`. It restarts the team server only if
the drop-in changed.

### Hosted team VM

A hosted server (`"hosted": true` in `root/install.json`) is a Trina Cloud team VM: one team on its own VM. The box can
run there only if the team's plan includes it. The plan says so in `/var/lib/mycel/root/dev-env.json`, root-owned
(`0644`, in the root-only `root/` folder):

```json
{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}
```

- No file: the script stops ("this team's plan does not include the dev environment").
- The script gives boxd `--limits-file` with this file and `--max-running` with `maxRunning`. boxd refuses a box with
  limits over these values ("limits over the plan"). The server account cannot change the file, so it cannot raise them.
- Network: a box gets `open` only if the file has `"network":"open"`. Without it, only `offline` works, and a project
  with network `open` gets an error at its first command: set its network to `offline`. An open box goes out from the
  host's public address with no allowlist, so the owner decides this per plan.
- Memory: the box comes on top of the plan. The VM must have at least `plan.json` `memoryMiB` plus the box's `memoryMiB`
  (`MemTotal`), or the script stops and boxd says boxes are not available. Example: a 4096 MiB plan with a 2560 MiB box
  needs 6656 MiB, so a 7 GB VM. A VM of the plan's size only is refused.
- boxd reads the file when it starts. After a change to the file, run the script again or restart `mycel-boxd`. If the
  file is gone, boxd says boxes are not available.
- Not done yet: the control plane cannot write the file or install the box, the kit has no `scripts/dev-env/`, the
  template has no podman, and a reimage loses the box (all its state is on the OS disk). For now an operator puts the
  file there and runs the script.

## 3. Update a server with the dev environment

Use the usual commands:

```bash
sudo mycel-ctl update
```

For daily updates in the team's update window:

```bash
sudo mycel-ctl auto-update on
```

`auto-update on` also restarts the server when no answer runs (it waits at most 120 s).

| Part | What an update does |
|---|---|
| `root/mycel-boxd` | It replaces the file with the one in the new kit. |
| `mycel-boxd.service` | It restarts only if the unit exists, the unit runs `root/mycel-boxd`, an administrator did not stop the service, and the program changed. A restart stops running boxes. A stopped box starts at its next use. If the program did not change, boxes are not touched by this step. After the restart the update asks boxd. If boxd does not answer, or says that boxes are not available, the result has a note and the update goes on. |
| Box image and seccomp profile | No change. They are not in the kit (section 5). |
| `dev-env.conf` (`MYCEL_DEV_ENV`) | No change. The update renders only the main units, so the dev environment stays on after an update and after a roll back. |
| `mycel-update.timer` | No change. |

A scheduled update waits for a moment with no running answer. It does not look at boxes, so a background command in a
box can stop if the program changed. To control the moment, leave auto-update off and use `sudo mycel-ctl update`.

`install-linux.sh update` also replaces `root/mycel-boxd`, and it restarts the service with the same rule as the table
above. If the restart fails, or if boxd does not answer after it, the installer gives a warning and goes on.

An older `install-linux.sh` replaced the file but did not restart the service. The old process then ran from a deleted
file. `sudo mycel-ctl update --bundle` finds such a process: if the content of the running program is not the content of
`root/mycel-boxd`, it adds a note and restarts the service, also when the root files match. To do this with no update,
restart the service yourself when no box runs:

```bash
sudo systemctl restart mycel-boxd
```

A roll back in the app does not change root programs, so `root/mycel-boxd` stays at the newer version.

A roll back to 0.2.18 or older does not hold while the timer is on: that app reads only `needsRoot`, so the timer installs
the newest release again at its next check. Before such a roll back, run `sudo mycel-ctl auto-update off`. This restarts
the server (it waits at most 120 s for running answers). Turn it on again when a fixed release is out.

## 4. Move an older install

An older `install-trial.sh` put the program in `/usr/local/sbin/mycel-boxd` and always turned off `mycel-update.timer`.
That server is stuck on its version. This section moves it. Steps 2 and 3 restart the team server, so do them when
nobody works. Step 4 restarts `mycel-boxd`, so running boxes stop. The team server does not restart for step 4, unless
its addresses changed.

1. Get the new scripts into `/opt/trina-ax`. If you added `ffmpeg` to the `Containerfile` on the server, drop that change
   first: the repo's file has it now.

2. Look at `allowUnsigned`:

   ```bash
   grep allowUnsigned /var/lib/mycel/root/install.json
   ```

   If it is `true`, the server counts as unsigned and the script keeps the timer off. An earlier `--allow-unsigned`
   install leaves it `true`. On a signed release, turn it off. This restarts the server: it waits at most 120 s for
   running answers, then it restarts and ends them.

   ```bash
   sudo mycel-ctl allow-unsigned off
   ```

3. Update, then look for the file. The update works with the timer off. It leaves the old service as it is.

   ```bash
   sudo mycel-ctl update
   ```
   ```bash
   ls -l /var/lib/mycel/root/mycel-boxd
   ```

4. Run the script again. If the file is there, it needs no `--boxd`:

   ```bash
   sudo /opt/trina-ax/scripts/dev-env/install-trial.sh
   ```

   If the file is not there, the newest release has no `mycel-boxd` in its kit. Keep the program you have:

   ```bash
   sudo /opt/trina-ax/scripts/dev-env/install-trial.sh --boxd /usr/local/sbin/mycel-boxd
   ```

   That program is still the old `mycel-boxd`, which compares only the image name. A box from before the rebuild keeps
   its old image, so it has no `ffmpeg`, until an update brings a kit with `root/mycel-boxd`. A new box takes the new
   image. The first such update runs the old `mycel-ctl`: it replaces the file, but it does not restart the service,
   and the timer can do that update with no person there. After that update, run `install-trial.sh` again when no box
   runs. It sees that the service runs a program other than the file, and it restarts the service. Then a box from before
   takes the new image at its next start.

   The script writes the unit with the new path, restarts `mycel-boxd`, and removes `/usr/local/sbin/mycel-boxd` after
   boxd answers from the new path. It rebuilds the image. On a signed release it also restores the timer:
   `/var/lib/mycel-boxd-trial/update-timer` has the state before the first run. If that state is `enabled`, the timer
   goes on again. If it is `disabled`, the timer stays off, as you had it. A later re-run does not change the timer
   again, so a timer that you turn off after this stays off.

5. Check:

   ```bash
   systemctl cat mycel-boxd | grep ExecStart
   ```
   ```bash
   sudo mycel-ctl auto-update status
   ```

   `ExecStart` must show `/var/lib/mycel/root/mycel-boxd`. If the status says that updates are still off, for example
   `install.json autoUpdate false` after a kit update with the timer off, run `sudo mycel-ctl auto-update on`.

## 5. Rebuild the image

An update does not rebuild the image. Rebuild it after a change in the `Containerfile` or `make-seccomp.py` in the repo:

```bash
sudo /opt/trina-ax/scripts/dev-env/build-image.sh
```

A running box does not stop, and a running render goes on. With a `mycel-boxd` from a kit that ships it, the box takes
the new image and seccomp profile at its next start. To start it now, use stop or restart on the project page. The
box volume (`node_modules`, caches) and the project folder stay. The build needs a few minutes of CPU and the internet,
so do it when nobody renders.

- `make-seccomp.py` changed in 0.2.20: a box now has no `fallocate` and no ioctl of type `X`, because these calls can fill
  the disk before boxd sees it. Run this build once after the update to 0.2.20. If you do not, the disk floor can come too
  late, and boxd logs `the box seccomp profile allows fallocate or its ioctls` at each box start. This profile has not run
  in a real box yet: if a box does not start after the build, that is the first thing to check.
- If the `Containerfile` did not change, podman uses its layers, so the image stays the same and gets no new Debian
  packages.
- If boxd says that the image or the seccomp profile is missing, it found that at its start, and it does not look again.
  After the build, run `sudo systemctl restart mycel-boxd`.
- The old image stays on the disk. To remove images that no box uses:

  ```bash
  cd / && sudo runuser -u mycel-devbox -- env XDG_RUNTIME_DIR=/run/user/$(id -u mycel-devbox) podman image prune -f
  ```

## 6. Not tested

- An update on a server with the dev environment has not run on a real server. Section 3 says what the code does, not
  what a test showed. The same is true for the move in section 4.
- The image with `ffmpeg` has not been built or tested in a real box. The build fails if `ffmpeg` has no `subtitles`
  filter. A render with subtitles has not run.
- The step of `vm-tests.sh` that gives the image a new ID under the same name has not run.
- Writes to `/work` have no size limit of their own, and `diskGiB` limits only the box volume. boxd now stops a box when
  the server disk comes under max(2 GiB, 5% of the disk), and the box stops with a reason that the people who may use it and
  the admins get. This protects the server disk, but it is no quota: one project can still use all the space down to that
  floor, and the stop ends what runs in the box. The disk floor, jobs, planted links and CPU as activity have tests for
  their decisions, but the steps of `vm-tests.sh` (`JOBS=1`, with `LONG=1`) have not run in a real box. The threshold of 10%
  of a core is an estimate until that run shows the number for an idle dev server. Keep the disk alert on the VM.
- A job that only waits uses no CPU, so it does not keep the box: a slow download can stop at the idle time.
- When a job ends, the person gets a notice and the next `box_shell` call gives the AI the result. The AI does not go on
  by itself.

The other open items are in `docs/DECISIONS.md` "Dev environment: what stops a release, and what stops a trial with one
team": the preview domain, the egress allowlist, the credential helper and WebSocket preview. Code in a box can send
project files out.

## 7. Remove it

This restores the packages and the account. Project folders stay; box volumes (`node_modules`, caches) go.

```bash
sudo /opt/trina-ax/scripts/dev-env/uninstall-trial.sh
```

`root/mycel-boxd` stays: the kit owns it, and the next update writes it again. It runs nothing without the service. The
script also removes `/usr/local/sbin/mycel-boxd` if an older install left it.

The timer: if `install-trial.sh` holds it off, the script restores the state from before the first run. Otherwise the
timer stays as it is.

## 8. Unsigned build

Use this only to test a branch before a release. Needs bun, Go and about 3 minutes, not on the team server. The version
must be higher than the feed's newest release. `--no-whisper` turns off voice input and the speech in video reads.

```bash
git checkout <branch> && bun install --frozen-lockfile
ARCHS=amd64 bash native/build.sh
bun run build:web
bun scripts/build-bundle.ts --os linux --arch amd64 --version <version>-devenv.1 --no-whisper --out dist/linux
```

Keep a copy of `root/install.json` first. Stop if `check` reports a problem. On a hosted team VM, the plan must include
the dev environment (`root/dev-env.json`, "Hosted team VM" above).

```bash
cd /opt/TrinaAX-server-<version>-devenv.1-linux-amd64 && ./install-linux.sh check --from . --allow-unsigned
```
```bash
cd /opt/TrinaAX-server-<version>-devenv.1-linux-amd64 && sudo ./install-linux.sh update --from . --allow-unsigned
```

Then run `install-trial.sh` as in section 2. On this route `mycel-update.timer` stays off, because the daily update must
not replace the build, and `allowUnsigned` stays true.

To go back to a signed release, use this order. A plain `mycel-ctl update` skips the release, because the build has a
higher version, and `allow-unsigned off` refuses while the unsigned build runs. The root files of the build stay until a
newer release replaces them.

```bash
sudo mycel-ctl update --version <release>
```
```bash
sudo mycel-ctl allow-unsigned off
```
```bash
sudo /opt/trina-ax/scripts/dev-env/install-trial.sh
```

The database copy and the full way back are in the older text: `git show 69b9158f:scripts/dev-env/TRIAL.md`, section 5.
