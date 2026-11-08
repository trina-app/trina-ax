---
title: Team skills
description: Turn how your team works into reusable SKILL.md instructions, governed by the same folder rules as files.
---

A skill is a reusable procedure in a `SKILL.md` file. It tells the AI how your team does a task. It does not train the model and never grants extra access.

## Use a skill

- In a chat, type `/` and pick a skill, or write `/skill-name` in your message.
- The AI can also find and load a skill by itself when it fits the request.
- **Team skills** in the sidebar lists the skills you can use.

![The Team skills page: tabs for available skills, review, suggestions and recent changes, and a list of six team skills](../images/skills/team-skills.webp "Team skills")

## Recommended skills

Four ready-made skills ship with the product, in the team's language (Korean or English; other languages get the English text). Nothing adds them by itself:

| Folder | Skills | How they get in |
|---|---|---|
| `skills/general/` | Company profile, Promo cards, Promo video | **Add 4 recommended skills** on an empty **Available skills** page (owners and admins) |
| `skills/work/` | Natural writing | The same button |

The welcome steps add none of them by themselves: a skill goes in only on a press that names it. The button on the empty page adds all four; it adds only what is missing. When the team has one of them at the end of the welcome steps, the last screen offers to make a first result with it (Promo cards first): the press opens the skill's form and nothing runs until you press **Run**. They are your team's own files: skill managers can edit, move or delete them. A skill you edited is never replaced, one you deleted never comes back by itself, and one whose name another team skill already uses is skipped.

**Natural writing** rewrites text that reads as AI-written so it sounds like a person wrote it, without changing any fact. The Korean version was written by the company and knows Korean genres (blog, Shorts titles, Instagram, proposals, notices); the English one is adapted from the open-source "humanizer" skill (MIT License, its notice is inside the skill).

Only skills with a known origin ship. Earlier versions also added skills for meeting tasks, document briefs, marketing, everyday work and Korean HR documents; teams that have them keep them as their own files.

## Where skills live

| Location | Who sees it |
|---|---|
| `skills/<name>/SKILL.md` | Everyone who can read `skills/` (usually the whole team) |
| `skills/<folder>/<name>/SKILL.md` | Only people who can read that folder, for example `skills/finance/` |
| `groups/<group>/skills/<name>/SKILL.md` | Only the members of that group. Not the owner or admins outside it. |
| `users/<you>/skills/<name>/SKILL.md` | Only you. Not even the owner or admins. |

When two skills share a name, the closest one wins, for you only: your personal skill, then your group's, then the team's. If two of your groups have a skill with the same name, both are listed with their folder, and `/name` uses the one of the group whose name comes first.

## Group skills

Every group has its own skills in its folder: `groups/<group>/skills/`, next to the group's files. Only the members of the group see and use them: in **Team skills** (one section per group, under the group's name), in the `/` menu (marked with the group's name) and in what the AI knows. The owner and admins do not get a group's skills unless they are in the group.

- Any member of the group can add or change its skills, like the group's other files. The AI asks you on a card before it saves one there, like for team skills, and every change is recorded with the group's name.
- A member can suggest a skill to their group (**Suggest as skill**, then the group's folder); the group's members review it.
- Renaming a group keeps its folder; the section in **Team skills** shows the new name at once. Deleting a group removes its skills from its members' lists.

A group skill is written by the group's members, not by the team's skill managers: what one member saves there, every member's AI follows.

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

## Bring your skills from Claude Code or Codex

Owners and admins can bring the skills they already use to the team, in the setup steps or from a proposal link:

| From | Pick or drop | What is read |
|---|---|---|
| Claude Code | `~/.claude` (or a project's `.claude`) | `skills/`, `commands/*.md`, `CLAUDE.md` |
| Codex | `~/.codex`, and `~/.agents` for current personal skills | `skills/` (never `.system`), `prompts/*.md`, `AGENTS.md`, the remote servers in `config.toml` |

Or, once Claude Code or Codex is connected to the team ([the MCP connector](../agents/mcp-connector.md)), paste one line into it and it sends a proposal.

- Nothing else in those folders is opened. A skill that holds a key or token never leaves your computer; only its name is listed.
- The server checks every skill again and suggests the ones the whole team can use. Nothing reaches the team before you press **Share with the team**.
- The rule file becomes one team rule. Remote MCP servers become connection templates without keys: each member connects with their own.
- A skill with the same name as a team skill is merged in a chat that can only read the two and save the team skill, after you confirm.
- **To one of your groups instead.** On the proposal's page, **Share with** picks the whole team (the default) or one of your groups; Claude Code and Codex can name the group too. A proposal to a group adds skills only (no team rule, no connections) and never changes a team skill: a skill named like one of the group's is merged into it or kept beside it, and one named like a team skill becomes the group's own copy. The group's members see it under **Team skills › Review** (only what goes to the group) and any of them can add it to the group. The setup steps always share with the team.

## Who can change skills

**Skill managers** change team skills: the owner, admins, and the people or groups an admin adds. Underneath, that is simply write access to `skills/` or a folder in it.

The owner and admins see who that is under the **Team skills** heading: "Who can edit: the owner and admins, Sales: 3 people, Alex [Change]". The list is what Folder permissions says for `skills/`, so it includes people who can edit through a group, an everyone rule or a rule on the whole team folder. Folders inside it with write rules of their own (for a person, a group or everyone) are counted at the end ("2 folders have write rules of their own"). **Change** opens one window:

- It lists the owner and admins (always) and every person and group with their own write rule on `skills/`, with the folder when the rule is on a subfolder such as `skills/finance/`. **Remove** takes that rule away after a confirm; it says so when another rule still lets the person edit (a group's, everyone's, or their own rule on `skills/`).
- **Add a person or group** finds one by name. Read the warning, then **Turn on**: they can edit all of `skills/`.
- To hand over one folder only, follow **To hand over one folder, use Folder permissions** and give write access on that folder there.

Members and other skill managers do not see the line.

- Members can **suggest** a personal skill to the team. A skill manager of the target folder reviews it.
- Every change to `skills/` is recorded, and the owner and admins get a notice with a link to the version history.
- A group's skills are changed by the group's members (see [Group skills](#group-skills)); their changes are recorded and announced the same way.

## Members bring their own skills

After a member's first good result with the skill their invite opened, one line under the answer asks whether they want to bring the skills or files they use to the team too. **Bring them** opens one sheet on a computer:

- The member picks or drops their `.claude`, `.codex` or `.agents` folder, read the same way as above. A skill that holds a key never leaves their computer.
- Nothing is ticked first. They tick up to 10 skills and send them as suggestions; up to 20 of their suggestions can wait at a time. Rule files and MCP servers are not sent.
- The server checks every skill again (keys, scripts, size, names, paths on their computer) and keeps it outside the team files. No AI judges it.
- When they can write the team folder, the sheet also links to it for files. On a phone the line offers only that folder, and nothing when they cannot write one.

The owner and admins get one Inbox line per send ("Mina wants to bring 2 skills to the team"), which opens **Review**, grouped by person. Only the owner and admins see and approve such a skill: it is saved as `skills/<folder name>/` with its files, the member hears it, and the skill shows "Suggested by Mina" in the list. Approving never changes the skill the invite opens or the 7-day goal names. The line can be closed for good with ✕.

## Starter skills

The repository has six starter skills with fictional inputs: weekly report, sales follow-up, brand brief, expense review, new-hire guide and meeting summary. [See the examples](../../../examples/README.md).
