# Windows dev checks: follow-up to #474

- Date (UTC): 2026-11-24 01:12
- Branch: `fix/windows-dev-checks-followup`
- Status: done
- Where: tests/unit, shared/src/cloud-protocol. Why: finish what #474 (by @meat-daemon-404, issue #469) started so local checks pass on Windows (see docs/REPOSITORY-RULES.md)
- Version impact: none (tests and repository settings only)

## Goal

Two Node `import()` calls in tests got absolute paths, which fail on Windows (`C:\...` is read as a URL scheme). The
`vectors.json` line-ending rule from #474 sits in the root `.gitattributes`, but the control plane copies
`shared/src/cloud-protocol/`, so the rule must travel with that folder.

## Scope

In: `pathToFileURL(file).href` in `tests/unit/push-gateway.test.ts` and `tests/unit/f-relay-node-strip.test.ts`; move the
rule to `shared/src/cloud-protocol/.gitattributes` and delete the root file (it held only that line).
Out: no line-ending changes in tests (signing fixtures are compared byte for byte); no workflow changes.

## Steps

1. Convert the two import paths.
2. Move the rule; check no script or test lists the folder's files (build-relay copies named files only).
3. Prove the rule in a throwaway repo with `core.autocrlf=true`.

## Decisions

none

## Risks

Existing Windows clones keep a CRLF `vectors.json` after pull; recovery commands are in the PR.

## Tests

`bun run typecheck`, `bun run test:unit`, `bun run check:prepush`, Node load check of the `file://` hrefs.

## Result

Both import paths use file URLs; the eol rule lives in shared/src/cloud-protocol/.gitattributes. Throwaway-repo proof and checks are in the PR.
