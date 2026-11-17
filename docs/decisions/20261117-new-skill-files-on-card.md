# A new skill's other files are shown on its SKILL.md card, never saved unseen

- Date: 2026-11-17
- Status: accepted
- Supersedes: the "after Save on a new SKILL.md, the other new files in that folder need no card" part of
  [20261117-new-skill-one-card.md](20261117-new-skill-one-card.md) (its name question, card words and one-SKILL.md
  instruction stay)
- Branch: fix/skill-one-card (QA MAN-052, second pass; plan docs/AGENTS/plan/20261117-1005-skill-one-card.md)

- **Ask:** MAN-052 on qa.trina.app: "turn this form into a skill" gave one question and two save cards
  (`skills/<name>/SKILL.md` and `skills/<name>/assets/<form>.md`), each showing raw file text. The first fix let the
  second file through after a Save on SKILL.md without showing it. Review rule: a skill or instruction file may only be
  changed with all of its new content on the card, and nothing may ride along on a yes without being shown.
- **Rule:**
  - **Held, then shown.** A `write` of a plain text file into a NEW skill's folder (the folder does not exist yet), in
    the same answer and before its SKILL.md, is held, not saved (chat/skill-held.ts, chat/turn.ts askSkillWrite). The
    AI is told "Not saved yet … write SKILL.md next … then write this file again with exactly the same content".
  - **One card.** The new SKILL.md's card shows the skill as before (what it does, its parts, the whole file folded)
    plus "This also saves 1 file that comes with the skill: form.md", and a list of each held file: name, size, first
    lines, the whole text one click away (SkillWritePreview.files, web AskCard HeldFiles).
  - **Exact bytes.** Save records each held file's sha256 for this answer. The AI's second write of exactly those bytes,
    after SKILL.md exists, saves with no card. Different bytes, another path, a later answer, or a "Don't save" ask on
    their own card (or are only held again while no SKILL.md is there). The wider-audience check still runs on that
    write: the held file's own folder (assets/) is covered by the SKILL.md card's yes only for the same sources and no
    other people than that card named (folderAudience); anything new asks. Once a SKILL.md got its Save, nothing more is held for that
    folder in the answer (a file checked before the SKILL.md reached the disk gets its own card, never a dead hold).
  - **What may be held** (structural, no text matching): `.md .txt .csv .tsv` inside the skill's folder, at most
    16,000 bytes, no NUL, no skill header (`---` first), not instruction-named (SKILL, CLAUDE, AGENT(S), GEMINI, COPILOT,
    CURSOR, CODEX … with anything after the name, such as CLAUDE.local.md or AGENTS.override.md; *instructions.md;
    .cursorrules …), not in a hidden folder or a steering folder (references/, scripts/, bin/, agents/, commands/,
    hooks/, rules/, prompts/; the skill's own folder name counts too), no invisible or direction-changing characters
    in the path or the text, at most 5 per skill. Everything else (scripts, code, HTML, Word/Excel/HWP
    made by make_file or edit_hwp, files of an existing skill, files after the SKILL.md) keeps its own card with its
    own text.
  - **Not held** in a scheduled run (nobody sees a card) or when the person has Always allow for skill saves on (no
    card to show it on; Rule A: their choice ends the asking).
  - **Removed:** the earlier pass-through (after Save on SKILL.md, later new files in that folder saved with no card
    and without being shown).
  - **Instructions** (NEW_SKILL_RULE): keep a new skill in one SKILL.md when it can; a form that must stay as it is goes
    first, then SKILL.md, then the held file again.
- **Why this design over a multi-file save tool:** the same write tool and every gate after the skill card (wider
  audience, room re-check, file guard) run for each file as before; only the skill card moves. A new tool would need
  new allow-lists in rooms, guests and engines.
- **Accepted residual:** a held file's text could contain words an AI would follow later (an injected form). It is on
  the card, folded, with its first lines visible; the person saw it before Save. The SKILL.md decides when it is read.
- **Independent review (Opus):** ship with fixes. Must-fix in: instruction names with more after the base name
  (CLAUDE.local.md, AGENTS.override.md, AGENT.md, copilot-instructions.md) were held. Also in: the skill folder's own
  name as a steering folder, invisible characters, the wider-audience cover for assets/, no hold after a SKILL.md Save.
  Accepted note: Always allow turned on between the hold and the SKILL.md card approves the held files unseen, as any
  skill save under Always allow is (Rule A).
- **Tests:** tests/unit/b-new-skill-one-card.test.ts (one card listing the form; held write not saved; SKILL.md first
  still two cards; no; changed text; script and references/ not held; rename; later answer; existing skill),
  web/test/unit/ask-card-new-skill.test.tsx (the list, size, first lines, folded text).
- **Version impact:** patch (one card instead of two, card list; no data change).
