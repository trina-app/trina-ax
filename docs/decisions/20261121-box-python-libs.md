# The dev environment has the common document and chart libraries, and pip install works in it

- Date: 2026-11-21
- Status: accepted
- Supersedes: none (adds to [docs/DECISIONS.md "Network. open now means an allowlist"](../DECISIONS.md) and the
  devenv group of scripts/system/packages.json)
- Branch: fix/box-python-libs (QA 2026-11-21, chat places P2; owner rule "Claude Code is the floor")

- **Ask.** In a box_shell run the AI could not use python-pptx: `pip install` failed and it wrote a PPTX by hand with
  zipfile. Claude Code installs python-pptx and uses it.
- **What was wrong.** On a Linux team server `pip install X` and `pip install --user X` stop with PEP 668
  ("externally-managed-environment", Debian's python3), so only a venv worked, which the AI did not try first. The
  network was not the cause: PyPI and npm are on the default allowlist since the srt design. python-pptx has no Debian
  package, and Pillow, matplotlib, pandas, reportlab and pypdf were not installed. The QA's own lxml error came from a
  cp39 lxml the tester copied in by hand, not from the product (a correct lxml loads in srt on Linux and on a Mac).
- **Rule.**
  - Linux: a run's python3 is a venv with the system's site-packages, `/opt/trina/python/python-pptx/current/bin`, first
    on PATH (packages.json `python.python-pptx`, `systemSite: true`). It sees apt's libraries (devenv group:
    python3-docx, -openpyxl, -lxml, -pil, -xlsxwriter, -numpy, -pandas, -dateutil, -packaging, -reportlab, -pypdf) and
    the venv's pinned wheels (python-pptx 1.0.2, matplotlib 3.10.9 and its small deps, typing-extensions). Debian's
    builds where Debian has them (security updates); pinned wheels by sha256 where it does not, resolved against
    Debian 12's versions so one set fits every release. Debian's own matplotlib is not used: it pulls scipy, sympy and
    tk (+180 to +640 MiB).
  - `pip install X` works in a run: a venv has no PEP 668 marker and, with the system's site-packages, the user site
    on, so pip installs into the run's home (`~/.local`, whose bin is on PATH). Same reach as before: PyPI only through
    srt's proxy, a team with No network still has none. No new network policy.
  - Node: pptxgenjs 4.0.1 and docx 9.15.3 from scripts/dev-env/srt/node-libs.package-lock.json (npm ci
    --ignore-scripts) in /opt/trina/node-libs/<lock sha12>, on `NODE_PATH` of a run, Linux and Mac.
  - box_shell's tool text names what is installed in one line, so the AI does not find out by trial.
  - Without them (an older install, `--minimal`, a failed download) a run works as before; the install says so.
- **Size.** Linux: apt +~90 MiB (Debian 13), the venv ~90 MiB on disk (~17 MiB download), Node ~31 MiB.
- **Left out.** The Python libraries on a Mac team server (/opt/trina/python3 has none; pip install works there). Debian's
  scipy and sympy. A pip or npm mirror.
- **Tests.** tests/unit/system-packages.test.ts (systemSite, the venv flag), tests/unit/dev-env-srt.test.ts (PATH,
  NODE_PATH, tool text), tests/linux/srt-attack.ts L1-L3 (every library loads inside srt, a deck with a chart, pip
  install into the home, a shared chat's fresh home).
- **Version impact.** patch: the dev environment offers more; a root update (the list changed).
