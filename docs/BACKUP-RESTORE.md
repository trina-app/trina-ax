# Backup and restore / 백업·복원

[IT guide](for-admins.md) · [IT 안내](for-admins.ko.md)

A local backup is on the same disk. Keep an encrypted off-host copy and test recovery. / 같은 디스크의 백업만으로는 부족합니다. 암호화한 외부 보관본과 복구 시험이 필요합니다.

## What is restored

| Operation | Restores | Does not restore |
|---|---|---|
| Admin → System → Backups → Restore | Database: accounts, chats, settings; applied at next server start | Team files are unchanged |
| `restore-team --backup ID --to NEWDIR` | Team files reconstructed from the full/incremental chain into a new folder | Does not replace the live team or database |
| `archive` / `restore-archive` | Database + team files (including file history present there), extracted to `db/app.sqlite` and `team/` | OS accounts, services, config, CA keys, provider secret keys and data-directory session state |
| Office `teamax restore-archive` | Stops the app and swaps the recovered DB/team into the office installation | Does not reconstruct missing deployment settings or external accounts |

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

- DB only: use Admin → System → Backups → Restore (password confirmation), or `trina_admin stage-restore --backup ID`. Restart the server (`sudo systemctl restart mycel-server` on default Linux). The old DB is retained under `data/backups/before-restore-*`. Everyone signs in again. Team files remain current.
- File recovery: `trina_admin restore-team --backup ID --to /var/lib/mycel/data/recovered-team`. The target must be new. Compare files, then restore only selected files through the app with appropriate permissions. This avoids replacing unrelated work.
- Encrypted archive drill: `trina_admin restore-archive --in /var/lib/mycel/data/off-host.tar.zst.age --to /var/lib/mycel/data/recovery-drill --password-stdin`. Verify the resulting DB and team tree; extraction alone does not start a server.

## Office replacement and a new machine

On a dedicated replacement Mac, install a compatible verified office ZIP and keep it private. Restore with `~/TeamAX/teamax restore-archive /path/to/trina.tar.zst.age`. It refuses a configured team unless `--replace` is explicitly supplied; that option replaces the active team's state and keeps old files beside it. The wrapper stops/restarts the office server. Reapply deployment settings and authorized AI connections. A new office CA requires clients to verify/trust the new fingerprint. Reconnect tunnels and clients to the intended address.

Linux/role-account Mac **do not have a general one-command new-machine recovery helper**. Install a compatible version on a dedicated replacement host, extract into a new staging folder, stop services, preserve the fresh installation, then have the operator place the recovered DB/team with the service account's ownership and restricted permissions. Keep secrets/config from the new installation and reconnect providers; never copy unknown keys from a support attachment. This manual migration path is not validated as a complete new-host recovery procedure by this documentation change. Do not treat extraction success as disaster-recovery certification.

## Verify before reopening access

Check SQLite integrity, log in again, verify a known file's content and history, compare two users' folder access, check skills, and review diagnostics. Reauthorize AI/integrations privately. Verify backup scheduling/timezone and create a fresh backup. Confirm old sessions no longer work. A rollback of app binaries does not roll back data.

Validation for this branch: a disposable local demo archive was encrypted, extracted and compared; DB-only and file-recovery unit coverage was run. Production Linux/role-account Mac and physical replacement-Mac recovery still need operator drills. The handoff report records exact results.
