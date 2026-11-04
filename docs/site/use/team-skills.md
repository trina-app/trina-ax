---
title: Team skills
description: Turn how your team works into reusable SKILL.md instructions, governed by the same folder rules as files.
---

A skill is a reusable procedure in a `SKILL.md` file. It tells the AI how your team does a task. It does not train the model and never grants extra access.

## Use a skill

- In a chat, type `/` and pick a skill, or write `/skill-name` in your message.
- The AI can also find and load a skill by itself when it fits the request.
- **Team skills** in the sidebar lists the skills you can use.

## Where skills live

| Location | Who sees it |
|---|---|
| `skills/<name>/SKILL.md` | Everyone who can read `skills/` (usually the whole team) |
| `skills/<folder>/<name>/SKILL.md` | Only people who can read that folder, for example `skills/finance/` |
| `users/<you>/skills/<name>/SKILL.md` | Only you. Not even the owner or admins. |

A personal skill with the same name as a team skill replaces it for you only.

## Write a skill

:::steps
#### Make the folder
Create `skills/<name>/` in Files. The name uses `a`–`z`, `0`–`9` and hyphens, and matches the folder name.

#### Write SKILL.md
Start with a header, then the procedure.
```markdown
---
name: meeting-summary
description: Summarize permitted meeting notes into decisions, actions and open questions.
---

# Inputs
Ask for the source paths before reading.

# Procedure and output
Return decisions, an action table and open questions. Cite the source paths.
```

#### Check it loads
**Team skills** shows a clear reason when a skill cannot load. Fix the header and try again.
:::

[Read the full SKILL.md format](../agents/skills-format.md).

## Who can change skills

**Skill managers** change team skills: the owner, admins, and people or groups an admin turns on with **Manages team skills**. Underneath, that is simply write access to `skills/` or a folder in it.

- Members can **suggest** a personal skill to the team. A skill manager of the target folder reviews it.
- Every change to `skills/` is recorded, and the owner and admins get a notice with a link to the version history.

## Starter skills

The repository has six starter skills with fictional inputs: weekly report, sales follow-up, brand brief, expense review, new-hire guide and meeting summary. [See the examples](../../../examples/README.md).
