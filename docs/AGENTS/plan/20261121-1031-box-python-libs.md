# The dev environment's Python and Node have the common document and chart libraries

- Date (UTC): 2026-11-21 10:31
- Branch: `fix/box-python-libs`
- Status: done
- Where: scripts/system (the one list), scripts/dev-env/srt, server/src/devenv. Why: the box is the AI's shell; what
  it offers is set by the list and the run's environment (docs/REPOSITORY-RULES.md)
- Version impact: patch: a fix to what the existing dev environment offers; a root update (the list changes)

## Goal

QA 2026-11-21 (chat places P2, a Mac test system): asked for a deck, the AI tried `pip install python-pptx` in
box_shell, failed, could not load a hand-copied lxml, and wrote the PPTX by hand with zipfile. Claude Code would
install python-pptx and use it (memory "AI should match Claude Code": fix the root, not a recipe).

What a run offers today (evidence in the PR):

- Linux team server: Debian's python3 (3.11 on Debian 12, 3.13 on Debian 13, 3.12 on Ubuntu 24.04) with apt's
  openpyxl, python-docx and lxml (the devenv group); node 22 from /opt/trina/node. No python-pptx (Debian has no
  package of it), no Pillow, matplotlib, pandas, reportlab or pypdf. Node has no packages.
- `pip install X` and `pip install --user X` stop with PEP 668 "externally-managed-environment" (reproduced in Docker
  Debian 13 + srt 0.0.81). The network is not the cause: PyPI and npm are on the default allowlist
  (shared/src/dev-env-domains.ts, docs/DECISIONS.md "Network. open now means an allowlist"); a venv's pip installs
  python-pptx in the same run, and its lxml loads.
- Mac team server: /opt/trina/python3 (python-build-standalone 3.13) with no libraries; pip works there (no PEP 668).
- The QA's lxml failure is not the product's: the tester copied a cp39 lxml from their own user site into the team
  folder. Reproduced on this Mac with srt 0.0.81: a cp39 lxml loads inside srt, and pip reaches PyPI.

## Scope

In:
1. Linux, apt (the devenv group): python3-lxml, python3-pil, python3-xlsxwriter, python3-numpy, python3-pandas,
   python3-dateutil, python3-packaging, python3-reportlab, python3-pypdf. Debian's own builds, security updates
   included; +~90 MiB. Not python3-matplotlib: it pulls scipy, sympy and tk (+180 to +640 MiB by release).
2. Linux, pinned wheels: a Python program `python-pptx` in /opt/trina/python/python-pptx (the list's existing venv
   mechanism) made with `--system-site-packages` (a new list key `systemSite`): python-pptx 1.0.2, typing-extensions,
   matplotlib 3.10.9 and its pure or small deps (contourpy, cycler, fonttools, kiwisolver, pyparsing). Resolved
   against Debian 12's numpy/Pillow/lxml, so one set fits every release. ~17 MiB download, ~90 MiB on disk.
3. The run's PATH starts with that venv's bin: `python3` there sees apt's libraries plus the venv's. A server without
   the venv keeps today's PATH. (Tried: letting `pip install X` go into the run's home. The user site is off on purpose,
   `PYTHONNOUSERSITE` for QA TC-4939, so other packages go into a venv of the folder, which the tool text says.)
4. install-srt.sh installs the devenv group's Python programs too (it installs the group's apt packages already).
5. Node: pptxgenjs and docx from a pinned package-lock (scripts/dev-env/node-libs), `npm ci --ignore-scripts` into
   /opt/trina/node-libs/<lock sha12> with a link current, by install-srt.sh and install-srt-mac.sh; `NODE_PATH` in the
   run's environment when it is there.
6. box_shell's tool text lists the preinstalled libraries in one line.

Out (later): the same Python libraries for a Mac team server's /opt/trina/python3 (macOS wheels per arch; pip install
works there today).

## Steps

1. This plan.
2. Tests: list rules (systemSite, the new packages, the program in the devenv group), runEnv PATH/NODE_PATH, tool text,
   a Docker test that imports every library inside srt and installs a PyPI package into a folder's venv (tests/linux).
3. The change; changes/box-python-libs.md; decision file.

## Decisions

docs/decisions/20261121-box-python-libs.md: what the box preinstalls (no new network policy: PyPI was allowed
already).

## Risks

A root update (the list). Bigger default Linux install (~150 MiB). A venv on PATH changes which `python3` a run uses:
same interpreter, plus the venv's packages. No migration, no UI strings.

## Tests

`bun test tests/unit/system-packages.test.ts tests/unit/dev-env-srt.test.ts`, typecheck, check:prepush, the Docker
import test with srt 0.0.81 on colima.

## Result

Built as planned, except step 3: a plain `pip install X` does not go into the run's home (the user site stays off,
QA TC-4939); the tool text points to a venv of the folder. Linux: apt +~90 MiB, the venv ~90 MiB (~17 MiB download),
Node ~31 MiB. Verified inside srt 0.0.81 in Docker on Debian 12, Debian 13 and Ubuntu 24.04 by hand, and in the srt
attack suite (LIB1-LIB3, all attacks and the 19 sub-agent cases held). The Mac team server's Python libraries are left
for later.
