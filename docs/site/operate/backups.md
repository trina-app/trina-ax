---
title: Backups
description: Back up the database and team files, keep an encrypted copy off the server, and practise restoring.
---

A backup on the same disk is not enough. Keep an encrypted copy somewhere else, and test that you can restore it.

## What each kind restores

| Operation | Restores | Leaves alone |
|---|---|---|
| **Admin › System › Backups › Restore** | The database: accounts, chats, settings | Team files |
| `restore-team --backup ID --to NEWDIR` | Team files, into a new folder | The live team and database |
| `archive` / `restore-archive` | Database and team files, encrypted | OS accounts, services, config and provider keys |

## Back up now

In every setup: **Admin › System › Backups › Back up now**. Check the time and result.

On an office Mac:

```sh
~/TeamAX/teamax backup
~/TeamAX/teamax archive /Volumes/Backup/trina.tar.zst.age
```

The archive asks for a password without showing it. Store the password separately: it cannot be recovered.

On Linux, run the admin tool as the service account. The [backup guide](../../BACKUP-RESTORE.md) has the exact commands, including `backup --scope full`, `list-backups` and `archive --password-stdin`.

## Restore safely

:::steps
#### Back up first
Make a current backup and pause team use.

#### Restore the database, or files to a new folder
The database restore applies at the next server start, and everyone signs in again. Files restore into a new folder, so you can compare and copy back only what you need.

#### Check before reopening
Sign in, open a known file and its history, compare two people's access, check skills and diagnostics, and reconnect AI and integrations.
:::

:::note
Backups may contain encrypted credential rows, but never the keys that unseal them. On a new machine, reconnect providers and integrations.
:::
