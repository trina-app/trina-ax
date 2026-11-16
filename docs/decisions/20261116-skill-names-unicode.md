# A skill's name may be in any language: 거래처-응대 is a skill

- Date: 2026-11-16
- Status: accepted
- Supersedes: the "lowercase ASCII" note in [P — Onboarding polish](../DECISIONS.md#p--onboarding-polish-skill-titles-the-invite-on-a-phone-the-checklist-featonboarding-p-2026-11-04) (its titles stay)
- Branch: fix/skill-names-unicode (AI scenario check 2026-11-16, SKL-11, root cause #10)

- **Ask:** `skills/거래처-응대/SKILL.md` with `name: 거래처-응대` was left out of the skill list without a word to the
  person using it: the name rule took lowercase a-z, 0-9 and hyphens only. A member then heard "you have no access".
  Office workers name folders in their own language; the Files screen already holds such folders everywhere.
- **Rule:** a SKILL.md folder's name (and its `name:` line) is words joined by single hyphens; a word is letters of any
  script with their combining marks and digits (`\p{Ll}`, `\p{Lm}`, `\p{Lo}`, `\p{Nd}`, then also `\p{M}`). A letter
  of a script with capitals must be lowercase (`\p{Lu}`/`\p{Lt}` are refused: `Quote`, `Отчёт`); Hangul, kana, CJK, Thai
  and Devanagari have no case and pass. No space, dot, underscore, slash or other sign; no hyphen at either end or
  twice. At most 64 characters (code points, not bytes). The name is NFC and the same in NFKC (full-width `ａｂ` and
  other compatibility forms are refused, so two names never differ only by such a form). The folder name and the
  `name:` line are compared after NFC, so a folder made in NFD on a Mac is the same skill. Also refused: invisible
  (default-ignorable) characters such as the Hangul filler, more than 200 UTF-8 bytes (64 letters outside the BMP),
  and Latin look-alikes: Latin mixed with Cyrillic or Greek letters (`quоte` with a Cyrillic о), or Latin letters
  beyond a-z once accents are off (`quıte`, `aǀb`). Where a name must be new (a project skill only adds names), a
  look-alike skeleton is compared (`skillNameSkeleton`: accents off, Cyrillic and Greek look-alikes as Latin), so a
  whole-word Cyrillic copy of a team skill's name is no new name either. One function holds it,
  `isSkillName` in `server/src/chat/skills.ts`; the loader, the write note, a renamed or moved copy (`copyNameOk`, also
  skill_files' rename), skill shares and suggestions, and the Skills page's folder-name check
  (`web/src/pages/Skills.tsx folderNameOk`) use it. "/거래처-응대" runs the skill; what was typed is compared in NFC.
- **Why it is safe:** the Agent Skills specification asks for "unicode lowercase alphanumeric characters" and hyphens,
  and its reference validator (skills-ref `_validate_name`) takes Unicode letters after NFKC and refuses only what is
  not lowercase, so these folders are valid Agent Skills. Nothing in Trina writes team skills into an engine's own skills
  folder (`~/.claude/skills`, `~/.codex/skills`): the AI loads them through the skill tool, so no engine sees the
  folder name. Names are compared exactly (NFC, letter case folded where there is case), so a look-alike letter from
  another script is another name, as it would be as a title today (`metadata.title` was already free text).
- **The AI never says "no access" for a skill that does not load:** when the skill tool is asked for a name that a
  readable skill file has but that file does not load (a broken header, a name this rule still refuses), its result
  names the file, says it does not load and that this is not about access, and who can fix it on the Skills page (the
  person for their own skill, else someone who manages skills); if the AI follows the file anyway, it is still that
  level's text and grants nothing (which shows the reason to everyone who can read the file). Only in the person's own chat; a
  room or a shared chat hears the usual "no skill" answer.
- **Skills sent from Claude Code or Codex** ("Bring my skills", `skills/share-check.ts validSkillName`) keep a name that
  passes this rule (a sent `거래처-응대` stays `거래처-응대` and meets the team's skill of that name); only another name
  is romanized into a slug, as before.
- **Left out:** a skill drafted from a chat or a form gets a slug the server makes (`onboarding/skill-draft.ts`), ASCII
  as before. Plugin manifests (`shared/src/plugins.ts` `SkillName`) are another format and stay ASCII
  (`^[a-z0-9]+(?:-[a-z0-9]+)*$`).
- **Tests:** `tests/unit/skill-names-unicode.test.ts` (the rule, NFC, "/name", the write note, a renamed copy, the web
  check), `tests/unit/b-skill-tools.test.ts` (the skill tool and "/거래처-응대" through the runtime; the "does not load"
  answer), `tests/unit/skill-name-rule.test.ts` (an invalid name still warns).
- **Version impact:** patch.
