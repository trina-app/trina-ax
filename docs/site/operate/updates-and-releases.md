---
title: Updates and releases
description: How servers update themselves, the stable and beta channels, and how to update by hand.
---

Linux servers and office Macs update from the signed Trina feed at `https://updates.trina.app`. The web app is part of each release, so new screens arrive with an update.

## Channels

| Channel | Gets | Tag example |
|---|---|---|
| **stable** | Normal releases | `v0.3.0` |
| **beta** | Pre-releases, and every stable release | `v0.3.0-beta.1` |

Version numbers follow Semantic Versioning. [Read how versions are chosen](../develop/versioning.md).

## Linux servers

- An update that changes only the app installs in the team's update window, when no answer is running.
- An update that changes root files waits for the update timer, or for `sudo mycel-ctl update`.
- The update window is in **Admin › Team settings**, in the team's time zone, picked by city with its UTC offset, such as "Seoul (UTC+9)" (03:00–05:00 when empty).
- The timer waits for a quiet moment instead of cutting answers off. An update waits for running work to finish, for up to 30 minutes. While it waits, **Admin › System** shows "An update is waiting for N running tasks to finish", and **Update now** asks whether to wait or update anyway. Scheduled runs and long commands start after the update.
- A server skips a release that cannot open its data yet (for example, a server on a development build that already updated its database further). **Admin › Home** and **Admin › System** say "Version … can't open this server's data yet. Waiting for a newer version." and show no install button.

```sh
sudo mycel-ctl status            # versions, units, health, update history
sudo mycel-ctl update            # update now
sudo mycel-ctl auto-update off   # stop automatic updates (on to turn back)
```

:::warning
A rollback restores the app, not the database or files. Back up before every update, and read the [release notes](https://github.com/trina-app/trina-ax/releases/latest).
:::

## Office Macs

```sh
~/TeamAX/teamax update status
~/TeamAX/teamax update now
~/TeamAX/teamax update pause     # or resume
```

Office updates run nightly while the user is logged in.

## Hosted teams

Trina installs updates during the maintenance window. There is nothing to run.

## Releasing (maintainers)

Maintainers bump `server/package.json` and `desktop/package.json`, then push a tag such as `v0.3.0`. GitHub Actions tests, builds, signs and publishes. [Read the release CI guide (Korean)](../../RELEASE-CI.md).
