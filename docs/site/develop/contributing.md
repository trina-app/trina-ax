---
title: Contributing
description: How to propose a change, what a good pull request contains, and what never to include.
---

Bug reports, docs fixes and small, focused improvements are welcome, in English or Korean.

## Before you start

- Search [existing issues](https://github.com/trina-app/trina-ax/issues) first.
- For a larger change, describe the problem in an issue before building it.
- Read the [code of conduct](../../../CODE_OF_CONDUCT.md) and [repository rules (Korean)](../../REPOSITORY-RULES.md).
- Report security problems privately: [Security policy](../../../SECURITY.md).

## Send a pull request

:::steps
#### Branch from main
Create a branch from current `main` in your fork or checkout.

#### Make one focused change
Keep unrelated formatting out of the diff. Update docs with behaviour changes.

#### Add your changelog note
Do not edit `CHANGELOG.md`. Put the user-visible notes in a new file `changes/<topic>.md`, where `<topic>` is the branch name without its prefix. [Read the rules](../../../changes/README.md).

#### Run the checks
At least `bun run typecheck` and the tests for what you changed. [See which checks](testing.md).

#### Fill in the template
Describe the problem, the change and how you checked it. Add a screenshot with fictional data for visible UI changes.

#### State the version impact
Write `patch`, `minor`, `major` or `none`, with one reason. [Read how to choose](versioning.md).
:::

## Never include

- Keys, tokens, cookies, setup or invite links
- Customer files, real conversations, real names or private host names
- Databases or unredacted logs

Reproduce with fictional data, and check every screenshot before you share it.

## Licence

Trina AX is AGPL-3.0-only, except `shared/src/cloud-protocol/` (MIT). Keep the existing copyright, licence and source-offer notices.
