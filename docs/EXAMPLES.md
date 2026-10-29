# Examples with synthetic data

First run the [local demo](QUICKSTART.md). File browsing does not need an AI account; the prompts below do.
Use the seeded files or invented documents, never real company information in a public bug report.

## Explain a company glossary

As `alice`, ask:

> Read shared/팀-용어집.md. Explain 전환율 in one sentence and cite the file.

Inspect the tool steps and compare the answer with the file. The example tests reading and attribution;
it does not guarantee that every model will answer correctly.

## Check two people's folder access

Use a normal browser window for `alice` and a private window for `bob`. Browse Files in both.
Alice can access the marketing group, while Bob can access finance but not its payroll subfolder.
Ask Bob's AI to list the marketing folder: it should not return that folder's files.
This check demonstrates the application's permission boundary; development mode still lacks production OS isolation.

## Reuse a meeting-summary skill

A user with write permission to the team's `skills/` folder can create `skills/meeting-summary/SKILL.md` through
Files and paste the contents of [this example SKILL.md](examples/meeting-summary/SKILL.md).
Members without that permission can use the skill suggestion workflow for review by a skill manager.

The skill becomes available to people who can read its folder. In chat, type `/` and select `meeting-summary`, then
provide a path to an invented meeting note. Expected structure: decisions, actions and open questions. Verify
names and dates against the source; the skill tells the model to mark missing information, not invent it.

`SKILL.md` supplies instructions. It does not grant new tools or bypass folder permissions.

## Connect an external service

Use **Settings → External services** for a personal connection or **Admin → External services** for a team one.
See [INTEGRATIONS.md](INTEGRATIONS.md) for supported MCP transports, authentication, HTTPS restrictions and write
policies. Credentials belong in connection settings, never in a skill or prompt. A service's availability and
permissions depend on its own configuration; this example does not provision a third-party account.
