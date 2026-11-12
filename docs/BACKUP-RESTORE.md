# Backup and restore / 백업·복원

[IT guide](for-admins.md) · [IT 안내](for-admins.ko.md)

A local backup is on the same disk. Keep an encrypted off-host copy and test recovery. / 같은 디스크의 백업만으로는 부족합니다. 암호화한 외부 보관본과 복구 시험이 필요합니다.

## What is restored

| Operation | Restores | Does not restore |
|---|---|---|
| Admin → System → Backups → Restore | Database: accounts, chats, settings; applied at next server start | Team files are unchanged, and so are folder permissions (who may open which folder stays as it is now) |
| `restore-team --backup ID --to NEWDIR` | Team files reconstructed from the full/incremental chain into a new folder | Does not replace the live team or database |
| `archive` / `restore-archive` | Database + team files (including file history present there), extracted to `db/app.sqlite` and `team/` | OS accounts, services, config, CA keys, provider secret keys and data-directory session state |
| Office `teamax restore-archive` | Stops the app and swaps the recovered DB/team into the office installation | Does not reconstruct missing deployment settings or external accounts |

Files sent in chat rooms (대화방) are kept in the team folder under `.system/rooms/`, a folder no person can open through the app (the owner and admins included) and that the owner's export leaves out, so every team-folder backup, archive, off-site copy and restore above includes them. When the team folder is on a network share or another disk, room files live there too. At every start the server compares them with the database without deleting anything on a guess: after a DB-only restore, room files the restored database does not know are moved to `.system/rooms-orphans/<time>/` and deleted after 30 days (so going back to the newer database stays possible within that time); a database row whose file is missing is kept and only counted in the log (its file answers "not found"); and when `.system/rooms/` is missing or cannot be read (a share not mounted yet) the check is skipped. / 대화방에서 보낸 파일은 팀 폴더의 `.system/rooms/`에 있어 팀 폴더 백업·보관·복원에 함께 들어가요(팀 폴더가 네트워크 공유에 있으면 대화방 파일도 거기 있어요). 서버가 시작할 때 DB와 비교하지만 짐작으로 지우지 않아요. DB만 복원하면 그 DB가 모르는 대화방 파일은 `.system/rooms-orphans/`로 옮겨 30일 뒤에 지워요.

Keep all members of a full/incremental backup chain. Do not copy a running SQLite database with plain `cp`; the CLI uses a consistent snapshot. Restored database copies invalidate saved sessions, unused invitations and password-reset links. Extracting an archive or restoring team files to a new folder does not end sessions on the running server; replacing its database requires everyone to sign in again. Backups may contain encrypted credential rows but not the sealing keys: on a new machine reconnect providers and integrations. Do not publish archives or passwords.

## Make a backup now

All modes: **Admin → System → Backups → Back up now**. Verify the timestamp and successful result. Record the backup ID privately.

Office Mac:

```sh
~/TeamAX/teamax backup
~/TeamAX/teamax archive /Volumes/Backup/trina.tar.zst.age
```

The wrapper asks for the archive password without echo. Store it separately; a lost password cannot be recovered here.

Linux (default install; run as the service account):

```sh
trina_admin() (
  cd / && sudo -u axserver env MYCEL_CONFIG=/var/lib/mycel/config/server.json \
    /var/lib/mycel/app/current/bin/bun \
    /var/lib/mycel/app/current/server/src/admin.js "$@"
)
trina_admin backup --scope full
trina_admin list-backups
trina_admin archive --out /var/lib/mycel/data/off-host.tar.zst.age --password-stdin
```

`--password-stdin` requires at least eight characters. Use a private terminal with echo disabled or pipe from your password manager; never put a real password in shell history or an argument. It reads until EOF. The JSON result must say `encrypted: true`. Copy the mode-600 archive to protected off-host storage and compare its SHA-256 at both ends. Do not leave this extra archive indefinitely in the data directory.

Role-account Mac uses the same `admin.js` commands as `_axserver`, with `MYCEL_CONFIG="/Library/Application Support/mycel/config/server.json"` and the executable paths under `/Library/Application Support/mycel/app/current/`. Check your installation ID and paths first; do not substitute Linux paths blindly.

## DB-only and file restore

Before any replacement, make a current backup, pause team use and preserve the current version/configuration.

- DB only (same version): use Admin → System → Backups → Restore (password confirmation), or `trina_admin stage-restore --backup ID`. To go back to the version you had before an update, do not restart: follow [Going back to the version before an update](#going-back-to-the-version-before-an-update-linux) instead. Restart the server (`sudo systemctl restart mycel-server` on default Linux). Folder permissions stay as they were just before the restore, because the files they protect stay too: a folder closed after the backup stays closed (if the current database cannot be read, the backup's permissions apply and Admin → System says to check them). After the restart, Admin → System → Backups and the activity log ("Restored a backup") say which backup was put back, when it was made, when and by whom it was restored, and whether it worked. The old DB is retained under `data/backups/before-restore-*` for the same period as backups (the newest one is always kept). Everyone signs in again. Team files remain current.
- File recovery: `trina_admin restore-team --backup ID --to /var/lib/mycel/data/recovered-team`. The target must be new. Compare files, then restore only selected files through the app with appropriate permissions. This avoids replacing unrelated work.
- Encrypted archive drill: `trina_admin restore-archive --in /var/lib/mycel/data/off-host.tar.zst.age --to /var/lib/mycel/data/recovery-drill --password-stdin`. Verify the resulting DB and team tree; extraction alone does not start a server.

## Going back to the version before an update (Linux)

Use this when an update (for example 0.4.0 → 0.5.0) went wrong and the team must run the old version again. The old version cannot read a database the new version has already changed, so you put back the copy of the database from just before the update and start the old version in one go. Do not use Admin › System › Update › Roll back or a plain server restart for this: a restart starts the new version, which changes the restored copy again.

What you lose: everything written in Trina after the update (messages and chats, new accounts, settings, scheduled-task runs). Everyone signs in again. Team files are not touched: files saved after the update stay; files sent in chat rooms after the update are moved to `.system/rooms-orphans/` and deleted after 30 days.

Define `trina_admin` as in [Make a backup now](#make-a-backup-now), then:

1. Turn automatic updates off, so the new version is not installed again tonight. Do this first: it restarts the server.

   ```sh
   sudo mycel-ctl auto-update off
   ```

2. Find the copy of the database from just before the update:

   ```sh
   trina_admin list-backups
   ```

   Take the newest entry with `"kind": "pre-migrate"` whose `createdAt` is the time of the update (the new version made it at its first start, before it changed anything). If there is none, take the newest `"kind": "pre-update"` entry from before the update. Note its `id`.

3. Stage that copy. Nothing changes yet:

   ```sh
   trina_admin stage-restore --backup <id>
   ```

4. Right away, install the old version. This stops the server, switches to the old version and starts it; the staged copy is put back when the old version starts:

   ```sh
   sudo mycel-ctl update --version 0.4.0
   ```

5. Check:

   ```sh
   sudo mycel-ctl status
   curl -s http://127.0.0.1:47820/api/health
   ```

   Both show the old version (`version 0.4.0`). `root files` still shows the newer version: that is expected, the root programs only move forward and work with the old version. Sign in, and open a chat and a file from before the update. Admin › System › Backups and the activity log say which backup was put back.

6. While automatic updates are off, Admin › Home shows the newer version with an **Install now** button. Do not press it until the problem is fixed. When you are ready to update again, make a backup and run `sudo mycel-ctl auto-update on` (or `sudo mycel-ctl update`).

## Office replacement and a new machine

On a dedicated replacement Mac, install a compatible verified office ZIP and keep it private. Restore with `~/TeamAX/teamax restore-archive /path/to/trina.tar.zst.age`. It refuses a configured team unless `--replace` is explicitly supplied; that option replaces the active team's state and keeps old files beside it. The wrapper stops/restarts the office server. Reapply deployment settings and authorized AI connections. A new office CA requires clients to verify/trust the new fingerprint. Reconnect tunnels and clients to the intended address.

### Linux: a new server from the archive

When the old server is lost, set up a new one from your off-host archive (made with `trina_admin archive`, see [Make a backup now](#make-a-backup-now)). Linux has no single command that does all of this; follow these steps in order. The paths are those of a default install (`/var/lib/mycel`, service account `axserver`, units `mycel-*`).

1. On the new server, install the **same version** as the old one (or a newer one) with `install-linux.sh`, as in [INSTALL-LINUX.en.md](INSTALL-LINUX.en.md). Do not open the setup page and do not create a team.
2. Copy the archive to the new server, check its SHA-256 against the one you recorded, and hand it to the service account:

   ```sh
   sha256sum off-host.tar.zst.age
   sudo install -o axserver -g axserver -m 600 off-host.tar.zst.age /var/lib/mycel/data/off-host.tar.zst.age
   ```

3. Define `trina_admin` as in [Make a backup now](#make-a-backup-now) and unpack the archive into a new folder (it asks for the archive password on standard input; the folder must not exist yet). This also checks the database copy and signs everyone out of it:

   ```sh
   trina_admin restore-archive --in /var/lib/mycel/data/off-host.tar.zst.age --to /var/lib/mycel/data/recovered --password-stdin
   ```

4. Stop Trina:

   ```sh
   sudo systemctl stop mycel-update.timer mycel-server mycel-launcher
   ```

5. Move the new install's empty database and team folder aside. Move `app.db-wal` and `app.db-shm` together with `app.db`: left behind, they would be applied to the restored database and damage it.

   ```sh
   sudo mkdir -m 700 /var/lib/mycel/data/fresh-install
   sudo sh -c 'mv /var/lib/mycel/data/app.db /var/lib/mycel/data/app.db-wal /var/lib/mycel/data/app.db-shm /var/lib/mycel/data/fresh-install/ 2>/dev/null; ls /var/lib/mycel/data/fresh-install'
   sudo mv /var/lib/mycel/team /var/lib/mycel/team.fresh-install
   ```

   The `ls` must show `app.db`, and `/var/lib/mycel/data/` must no longer have `app.db-wal` or `app.db-shm`.

6. Put the recovered database and team folder in place (`db/app.sqlite` becomes `data/app.db`, `team/` becomes the team folder):

   ```sh
   sudo mv /var/lib/mycel/data/recovered/db/app.sqlite /var/lib/mycel/data/app.db
   sudo mv /var/lib/mycel/data/recovered/team /var/lib/mycel/team
   ```

7. Give them to the service account, readable by it only (folders 700, files 600, as a new install has them):

   ```sh
   sudo chown -R axserver:axserver /var/lib/mycel/team /var/lib/mycel/data/app.db
   sudo chmod 600 /var/lib/mycel/data/app.db
   sudo find /var/lib/mycel/team -type d -exec chmod 700 {} +
   sudo find /var/lib/mycel/team -type f -exec chmod 600 {} +
   sudo stat -c '%U %a %n' /var/lib/mycel/team /var/lib/mycel/data /var/lib/mycel/config /var/lib/mycel/data/app.db
   ```

   The last line must show `axserver 700` for the three folders and `axserver 600` for `app.db`.

8. Start Trina and check it:

   ```sh
   sudo systemctl start mycel-launcher mycel-server mycel-update.timer
   sudo mycel-ctl status
   ```

9. Everyone signs in again with their old password. Old sign-ins, unused invite links and password-reset links no longer work: send new invites where needed.
10. Connect the AI accounts again in **Admin › AI accounts**, and reconnect integrations (Google, Slack and others). Their keys were sealed with the old server's keys, which are not in the archive; never copy key files from the old server or from a support attachment.
11. Do the checks in [Verify before reopening access](#verify-before-reopening-access), make a new backup, then delete `/var/lib/mycel/data/off-host.tar.zst.age` and `/var/lib/mycel/data/recovered`. Keep `fresh-install` and `team.fresh-install` for a week, then delete them.

If the team folder is not in `/var/lib/mycel/team` (a network share or another disk: `teamRoot` in `/var/lib/mycel/config/server.json`), use that path in steps 5–7 instead. The new server's settings, certificates and keys stay those of the new install; the archive does not carry them.

Role-account Mac has no such helper either: use the same steps with its paths (`/Library/Application Support/mycel/`, account `_axserver`); they have not been tried on a Mac yet.

## Verify before reopening access

Check SQLite integrity, log in again, verify a known file's content and history, compare two users' folder access, check skills, and review diagnostics. Reauthorize AI/integrations privately. Verify backup scheduling/timezone and create a fresh backup. Confirm old sessions no longer work. A rollback of app binaries does not roll back data.

Tested: a disposable local demo archive was encrypted, extracted and compared; DB-only and file-recovery unit coverage was run. On Ubuntu 24.04 VMs (2026-11-12) the steps for going back after a 0.4.0 → 0.5.0 update (QA TC-337) and for a new Linux server from the archive (QA TC-362) were run on real installs: the team came back with its data, sign-ins and folder access, and the database passed its integrity check. Role-account Mac and physical replacement-Mac recovery still need operator drills.
