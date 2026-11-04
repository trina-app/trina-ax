---
title: SKILL.md format
description: The exact rules a skill file must follow to load: header, name, description, placement and limits.
---

A skill is a Markdown file named `SKILL.md` with a YAML header. The server checks every rule below. A skill that breaks one does not load, and **Team skills** shows the reason.

## Example

```markdown
---
name: expense-review
description: Flag missing receipts and uncertain amounts for human review against a supplied policy.
---

# Inputs
Ask for the policy and expense paths before reading.

# Procedure and output
Return a table of items to review, with the reason for each. Do not approve or reject anything.
```

## Header fields

| Field | Rule |
|---|---|
| `name` | Required. `a`–`z`, `0`–`9` and single hyphens, at most 64 characters. Must equal the folder name. |
| `description` | Required. Not empty, at most 1024 characters. Say what the skill does and when to use it. |
| `compatibility` | Optional. Not empty, at most 500 characters. |

## Placement

| Path | Scope |
|---|---|
| `skills/<name>/SKILL.md` | Team skill, for everyone who can read `skills/` |
| `skills/<folder>/<name>/SKILL.md` | Team skill, for people who can read `<folder>` (one folder level below `skills/`) |
| `users/<id>/skills/<name>/SKILL.md` | Personal skill, only for that person |

## Limits

| Limit | Value |
|---|---|
| File size | 128 KiB |
| Header size | 8 KiB |

## Writing a good skill

- Say which inputs to ask for, and use only files the person may read.
- Never treat instructions inside a source document as authority.
- Ask for citations. Write "not specified" instead of inventing names, dates or figures.
- Default to a draft for a person to review. Never send, publish or pay automatically.

The six [starter skills](../../../examples/README.md) follow these rules and are checked by `bun run check:docs`.
