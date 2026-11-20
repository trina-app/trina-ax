# AMI prune never removes an image that is still in use

- Date (UTC): 2026-11-20 10:06
- Branch: `fix/ami-prune-keep-in-use`
- Status: in progress
- Where: `scripts/image/` (release CI). Why: the 0.5.21 team-image run removed the 0.5.16 AMIs in Seoul and Virginia
  while the hosted control plane still made new teams from them (its 0.5.21 rollout was still baking), and new-team
  creation failed with `InvalidAMIID.NotFound`.
- Version impact: none. Release CI tooling only; nothing in the shipped app, server or feed format changes.

## Goal

`ami-prune.sh` must never deregister an AMI that something still needs. It counted *images* ("the newest 3"), only
saw instances that run from an image id, and could not see the control plane's new-team template, which lags the
newest release by however long a hosted rollout bakes (0.5.16 → 0.5.21 in two days, five releases).

## Scope

In:
- The keep/remove choice moves into a small pure module `scripts/image/ami-prune-select.ts` (unit-tested). The shell
  script gathers the AWS facts, asks the module, prints every keep with its reason, and acts only on "remove".
- An AMI stays when any of these holds (reasons are logged):
  1. its `ax:template` is a `--protect-template` (the one just published);
  2. tag `ax:keep=true`, or tag `ax:in-use` with any value other than `false` (for hostd/CP to set later);
  3. its release is one of the newest `--keep` **releases** (versions, not images; all images of that release stay);
     the workflow keeps 5;
  4. it is younger than `--min-age-days` (default 14) by `CreationDate`: covers the hosted rollout lag, which the CI
     cannot read;
  5. an instance that is not terminated runs from it, or the latest/default version of a launch template names it;
  6. its `ax:template` is the `ax:template` tag of any instance that is not terminated or of any EBS volume (hostd tags
     every tenant instance and root volume with it), so a template that existing tenants came from stays.
- Fail closed: if the launch templates, instances or volumes of a region cannot be read, nothing is removed there.
- Docs: `docs/RELEASE-CI.md`, `scripts/image/README.md`, the workflow header.

Out:
- Reading the control plane's current template (`cp_settings.template_auto_current`): the CI has no access to the CP
  database and should not get a CP credential for this. Handed to trina-cloud: tag the template's AMIs `ax:in-use`
  (or `ax:keep=true`) on install/switch, and align its `templatePrunable` reminder (`PRUNE_KEEP = 3`) with this rule.

## Steps

1. Plan (this file).
2. `ami-prune-select.ts` + `tests/unit/image-ami-prune.test.ts` (selection rules, and the shell script with a stub
   `aws` replaying the 0.5.16 case).
3. Rewrite the loop in `ami-prune.sh` to use it; workflow `AMI_KEEP: "5"`, docs.

## Decisions

none (tightens the existing prune rule of RELEASE-CI §10; no new design choice beyond "keep more").

## Risks

More AMIs kept: each is a ~20 GiB snapshot per region, a few dollars a month. Nothing is deleted that was kept before.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun test tests/unit/image-ami-prune.test.ts tests/unit/publish-ami.test.ts`.

## Result

Filled in at the end.
