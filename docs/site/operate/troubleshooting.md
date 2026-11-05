---
title: Troubleshooting
description: Common problems by symptom, with what to check and what to do.
---

Use fictional data when you report a problem. Never paste keys, setup or invite links, databases or raw logs.

| Symptom | Check | Next step |
|---|---|---|
| Files open, AI does not answer | **Admin › AI providers**: missing program, sign-in, version or network error | Fix the reported cause. Never turn isolation off. The demo has AI off on purpose. |
| AI connection unavailable | **Admin › AI providers**, the engine's accounts: kind, state, assignment and consent | Reconnect privately over HTTPS. |
| Sign-in repeats or origin rejected | Host name, scheme and port in the browser | Use one address. `localhost` and `127.0.0.1` are different origins. Check `MYCEL_PUBLIC_ORIGINS`. |
| Address already in use | The port the demo or installer prints | Stop only your own process, or pick a free port. |
| Socket path too long | The data folder path | Use a short folder in your home directory. |
| Linux says systemd is required | Is PID 1 systemd? Is cgroup v2 there? | Use a supported VM or host. |
| A skill is missing | **Team skills** warning, `SKILL.md` header, folder name, permissions | Compare with the [starter skills](../../../examples/README.md). |
| Office server stops at logout | The LaunchAgent runs in the signed-in session | Keep the dedicated user signed in. |

## Status commands

| Setup | Commands |
|---|---|
| Linux | `sudo mycel-ctl status`, `systemctl status mycel-server mycel-launcher`, `journalctl -u mycel-server -n 100` |
| Office Mac | `~/TeamAX/teamax status`, `~/TeamAX/teamax update status`, `~/TeamAX/teamax logs` |
| Local demo | The URL and supervisor PID that `bun run demo` prints. Ctrl-C stops it. |

More: [Troubleshooting](../../TROUBLESHOOTING.md) · [FAQ](../../FAQ.md) · [Support](../resources/support.md)
