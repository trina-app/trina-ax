# Word, PowerPoint, Excel and PDF are built with document skills

- Date: 2026-11-24
- Status: accepted
- Supersedes: none (reopens docs/decisions/20261120-office-skills.md, as its "Reopen when" asks)
- Branch: feat/doc-skills

- **Ask.** Owner: every document should look like a designed page, at least as good as Claude's. Measured root causes:
  only PDF had a source that can express design (the prompt sent the rest through Markdown), and the AI could not see
  Word or Excel pages.
- **Rule.** Where a run exists, the AI reads Anthropic's docx, pptx, xlsx or pdf skill, builds the file with real
  libraries in its work folder, saves it through the normal file tools, reads the saved pages and fixes them. Hangul
  stays on make_file. Where no run exists, make_file stays.
- **Origin.** github.com/anthropics/skills at the commit in `resources/doc-skills/SOURCE.json`, Apache-2.0 since upstream
  #2146 (2026-11-06). The XSD schemas (ISO/IEC 29500, ECMA-376, Microsoft) are left out: they state no licence of their
  own, so the validator skips that check and prints `NOT CHECKED`. `resources/doc-skills/README.md` records the changes.
- **Not a team skill.** The skills are part of the program, in the server's read-only bin folder. Nothing is added to a
  team's folder or skill list (the "no auto-add" rule of DS3).
- **The look step is on the server.** The skill's own `run_soffice` was tried in a real srt run with seccomp unchanged. It
  stops with `ERROR: no valid pipe path found`: LibreOffice's pipe path is fixed to /tmp or /var/tmp, which a run cannot
  write. Opening /tmp as a diagnostic got past that error and still made no PDF, and opening it in the product would widen
  the sandbox, so the shim is not used.
  `read` with `as_images` draws a saved .docx or .xlsx with LibreOffice in the converters' bwrap isolation.
- **Office Mac and Mac team servers.** LibreOffice is never installed on a Mac. An existing install is not used either:
  it does not start in the converter sandbox unless its network, exec and file rules are loosened, and the sandbox is not
  loosened for a preview. Quick Look (`qlmanage`) does not start in that sandbox. The AI says it did not see the pages.
- **Install types (phase 1 of docs/AGENTS/plan/20261124-0314-doc-quality-all-situations.md, owner OK 2026-11-24).**

  | Install | Skills | LibreOffice (page view, Excel values) | When something is missing |
  |---|---|---|---|
  | Hosted, Debian 13 | With the dev environment on | apt, `office-view` default group, floor `4:25.2.3-2+deb13u12` | make_file; still views pages |
  | Ubuntu 24.04 | With the dev environment on | Not installed until its CVE-2026-63277 fix | Says pages and formula results were not checked |
  | Debian 12 | No (no srt run) | Not installed | make_file, says so |
  | Docker default image, `--minimal` | No | Not installed (always groups only) | make_file, says so |
  | Office Mac, Mac team server | No | Not used | make_file, says so |

- **Exit check.** Every Office file that leaves a run is scanned like make_file's output (office-links-check.ts):
  save_work_file, copy_files, chat attachments, chat-file versions, and files a command or a job writes straight into a
  project or the person's own folder (devenv/track.ts: refused files are undone). An edit keeps the risky items its
  earlier version, the file it replaces or a file this answer read already held, so a company template keeps working.
  A file saved through the file layer between commands is a person's and is not undone.
- **Excel values.** A workbook leaving the work folder is recalculated by LibreOffice in the converters' isolation (a
  throwaway profile with macros off and recalculate-on-load), and only each formula's result is copied into the
  original (files/xlsx-values.ts). Where that cannot run, the save result tells the AI to say so.
- **Decks** are drawn through LibreOffice where the server has it; elsewhere by the server's own slide renderer.
- **Cost (Debian 13, 4 GiB and 2 CPUs, arm64).** About 0.8 s per page render and 0.9 s per Excel recalculation. Peak
  memory 200-300 MiB for a 5-page Word file, under 200 MiB for a workbook or deck. LibreOffice's libraries take
  280 MiB on amd64; the install is about 440 MiB with its dependencies. User namespaces do not work under amd64
  emulation, so the isolated render was measured on arm64.
- **Security.** AI-written code builds documents, only inside the srt run. LibreOffice opens files in bwrap with no
  network, a throwaway profile, macros off, and time, memory and disk limits. Vendored files are copied by sha256 and
  are read-only in a run.
- **Version impact.** minor. A root update, because the package list changes.
