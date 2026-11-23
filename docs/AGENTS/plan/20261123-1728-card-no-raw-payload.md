# Confirm cards never open on raw JSON, code or a long payload

- Date (UTC): 2026-11-23 17:28
- Branch: `fix/card-no-raw-payload`
- Status: done
- Where: web/src/lib/cardPayload.ts, web/src/components/chat/AskCard.tsx. Why: the final 0.16.0 gate showed a 6,935-character JSON payload open on a card
- Version impact: patch, a display fix on confirm cards

## Goal

A person decides from a plain line. The full content is behind 자세히, for every card kind.

## Scope

In: one client rule for every card detail. What a person must see to decide stays in view: recipients, addresses, long random-looking values and red alert lines.
Out: the phone app's card; the diff on a change to an existing skill, which stays in view on purpose.

## Steps

1. Detect a machine payload by its shape, with no per-tool list.
2. Fold complete JSON behind 자세히 with its label, size and plain lines of every key and value.
3. Tests for JSON, prose, scripts, recipients, addresses and marks.

## Decisions

docs/decisions/20261124-card-no-raw-payload.md

## Result

See the PR.
