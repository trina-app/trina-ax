---
title: Core and Trina
description: How Trina AX relates to the shared Team AX core, and where a change belongs.
---

Trina AX is built on a shared core, **Team AX**. Most features are shared. Trina adds its own branding and a few features of its own.

## Where a change belongs

| Change | Goes to |
|---|---|
| Chat, permissions, files, skills, phone, AI connections, usage, Linux runtime | The core first, then into Trina |
| Trina branding | `editions/trina/branding/` in this repository |
| Billing, plans, hosting operations, customer addresses | A private repository, never this public one |

A new feature's description starts with one line: `넣을 곳: <repository/folder>, 이유: <one sentence>` ("where it goes, and why").

## You only need this repository

External contributors open issues and pull requests here. You do not need access to the core. Maintainers route changes to the core when needed.

## How core changes arrive

- The core's history is never pushed to this public repository. Changes come through a filtered mirror or by hand.
- Each import is recorded in [`docs/UPSTREAM.md`](../../UPSTREAM.md), with the source, the filter and how conflicts were resolved.
- Some core files never come here, such as private docs and mirror scripts.

## Actions that need approval

Renaming, creating or publishing GitHub repositories, rewriting history or force-pushing, merging or pushing to the core's `main`, connecting to customer servers, and changing billing or cloud accounts all need the company head's approval first.

Source: [Repository rules (Korean)](../../REPOSITORY-RULES.md).
