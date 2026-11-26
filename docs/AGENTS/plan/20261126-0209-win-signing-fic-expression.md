# RELEASE-CI 11: the Windows signing federated credential as it really works

- Date (UTC): 2026-11-26 02:09
- Branch: `docs/win-signing-fic-expression`
- Status: done
- Where: docs/RELEASE-CI.md 11장. Why: the documented flexible federated credential cannot be created as written
- Version impact: none, docs only

## Goal

The next person who sets up Windows signing copies a command that works.

## Scope

In: 11장 step 7 (expression, repository id after the 11-19 repo swap, Entra limits), the app that now exists, and the
order of the remaining steps.
Out: release.yml (unchanged), 10장's AWS trust policy (same stale repository id; separate change).

## Steps

1. Create the app registration and the credential in Entra (done 2026-11-26) and note what Entra refused.
2. Rewrite step 7 with the expression that Entra accepted.

## Decisions

- One credential, immutable subject only: Entra refuses a `sub` match without the owner/repository ids
  ("The 'sub' claim is not immutable"), and a matching expression is at most 128 characters, so the workflow path is
  matched as `*/workflows/release.yml@refs/tags/v*`.

## Result

Docs match Entra. Signing itself still waits for the Microsoft identity validation (In Progress on 2026-11-26).
