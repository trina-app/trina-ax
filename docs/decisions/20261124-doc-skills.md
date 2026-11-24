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
- **The look step is on the server.** srt's seccomp filter refuses AF_UNIX sockets, so LibreOffice cannot start in a run.
  `read` with `as_images` draws a saved .docx or .xlsx with LibreOffice in the converters' bwrap isolation.
- **Office Mac and Mac team servers.** LibreOffice is never installed on a Mac. An existing install is not used either:
  it does not start in the converter sandbox unless its network, exec and file rules are loosened, and the sandbox is not
  loosened for a preview. Quick Look (`qlmanage`) does not start in that sandbox. The AI says it did not see the pages.
- **Install types.**

  | Install | Skills | Libraries | Korean fonts | LibreOffice | When something is missing |
  |---|---|---|---|---|---|
  | Hosted (Linux image) | With the dev environment on | One list | Noto CJK | apt, about 420 MiB | make_file, still views pages |
  | Debian 13, Ubuntu 24.04 | With the dev environment on | One list | Noto CJK | apt, 419-441 MiB | make_file, still views pages |
  | Debian 12 | No (no srt run) | Not used | Noto CJK | apt, about 403 MiB | make_file, still views pages |
  | Docker | No (no run) | Not used | Noto CJK | apt, about 600 MiB with fonts | make_file, still views pages |
  | Office Mac | No (no run) | Not used | macOS fonts | Not used | make_file, says pages were not seen |
  | Mac team server | No (no Python libraries) | Not used | macOS fonts | Not used | make_file, says pages were not seen |

- **Security.** AI-written code builds documents, only inside the srt run. LibreOffice opens files in bwrap with no
  network. Vendored files are copied by sha256 and are read-only in a run.
- **Version impact.** minor. A root update, because the package list changes.
