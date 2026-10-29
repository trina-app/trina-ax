# Try Trina AX locally

[한국어](QUICKSTART.ko.md) · [Team guide](for-teams.md)

This is a fictional, model-free evaluation, **not a production install**. No AI account is required. It demonstrates files, team skills and application permissions, not AI quality or production isolation.

## Requirements

Use macOS or Linux with Git, Bun 1.3.12 (CI pin), Go 1.27+ and native build tools (Xcode command-line tools on Mac). The initial build downloads dependencies. Windows users can use a browser connected to a prepared demo host; a native Windows server walkthrough is not provided. Allow about ten minutes on a prepared machine; new tool installation takes longer. This walkthrough was exercised on macOS; Linux source evaluation needs validation on your machine.

```sh
git clone https://github.com/trina-app/trina-ax.git
cd trina-ax
bun install --frozen-lockfile
bun run demo
```

The single foreground command builds the app, starts it on **http://127.0.0.1:19760**, and seeds fictional data, six starter skills and a clearly labeled illustrative result file. It prints the dedicated data directory and process ID. It binds to loopback, starts no relay, and disables both AI engines, even if this computer has existing CLI logins. Do not expose it or add real data.

Optional choices:

```sh
bun run demo --port 19761 --data "$HOME/.trina-evaluation-new" --locale ko
```

The data directory must **not exist**. Existing and non-demo directories are refused. Choose a short path outside `/tmp` on macOS because sandbox/socket paths have platform limits. A busy port is refused before seeding. Each default run creates a new directory; old runs are never silently reset.

## Your first result

1. Sign in as `alice`, password `teamax-demo-1` (public fictional demo credentials).
2. Open **Files → shared → 팀-용어집.md** to preview the glossary.
3. Open a separate browser profile as `bob` with the same demo password. Alice sees the marketing group; Bob sees finance. Bob cannot see its payroll subfolder.
4. Sign in as `dion` (fictional owner) to explore team skills and administration. [Copy a starter skill](../examples/README.md).

The files are Korean; the UI starts in English unless `--locale ko` is supplied. The sign-in screen has English / 한국어 language buttons. In the app use Settings → Profile → Language.

## Stop and clean up

Press **Ctrl-C** in the foreground terminal. The launcher stops its own server by PID. Data stays in the directory printed at startup. Once stopped, delete only that dedicated demo directory if you no longer need it. Never delete a real team's directory. A failed build can leave an empty demo directory; choose a new path on retry.

AI is deliberately unavailable here. For an optional real model task, use a separate development environment with a permitted account as described in [DEVELOPMENT.md](DEVELOPMENT.md), or arrange [hosting](https://ax.trina.app/#contact). Provider charges and terms apply.

[Problems starting?](TROUBLESHOOTING.md) · [Linux production](INSTALL-LINUX.en.md) · [Office Mac](OFFICE.en.md)
