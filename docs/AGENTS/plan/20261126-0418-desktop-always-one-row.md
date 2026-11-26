# Desktop e2e red: one Always shows as two allowed sites

- Date (UTC): 2026-11-26 04:18
- Branch: `fix/desktop-always-one-row`
- Status: done
- Where: desktop/ (pane.ts), tests/unit, docs/decisions. Why: Desktop e2e fails on dev since #577 (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a duplicate row in the allowed-sites list goes away (no new behaviour)

## Goal

Since #577 (Review 2, 9d1f937c3) one "Always allow" on a public site saves two entries on the computer: the named site
(`shop.test`) and the host (`shop.test:19153`, or `news.naver.com`). Settings > Browser and the pane list show two rows
with two Delete buttons for one answer; desktop.spec.ts:528, settings.spec.ts:41 and person.spec.ts:17 fail on it.

## Scope

In: `BrowserPane.grant` saves one entry per Always. A host without a port: only the named site (it covers the host and
its subdomains already, `SitePermissions.isAllowed`). A host with a port: only host:port (the site entry has no port, so
it would allow other ports the person was not asked about). No site to keep: the host, as before.
Out: server side, the e2e specs (their expectation, one row, was right).

## Steps

1. Fix `grant`; update the unit test that pinned the pair.
2. Run desktop e2e specs and `check:prepush`.

## Decisions

The doc line "keeps both the host with its port and the named site" in 20261125-one-site-always-desktop-browser.md is
corrected in place (same-day, status accepted).

## Result

desktop.spec.ts (22), person.spec.ts:17 and settings.spec.ts:41 pass locally on macOS; e-pane-one-always unit and check:prepush pass.
