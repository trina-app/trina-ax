# Team invite message says the link is shared and until when it works

- Date (UTC): 2026-11-25 09:02
- Branch: `fix/team-link-message-shared-note`
- Status: in progress
- Where: web (lib/team-link.ts, the two places that build the message, i18n). Why: the copy is built on the web side only.
- Version impact: patch. One added line in a ready-made message; no API, data or behaviour change.

## Goal

Owner, 2026-11-25: people who get the team invite message think the link is personal. Admin › Members says "링크 하나로
여러 명이 들어와요" (`teamLink.desc`), but the message the admin copies never says it, nor until when the link works.
The message gets one line before the link: several teammates can join with this one link, and it works until {date}.

## Scope

In: new key `teamLink.msg.shared` (en source, then ko, ja, zh, es, id); `teamLinkMessage` takes the link's expiry,
formatted like `teamLink.until` (`formatDateTime(expiresAt, locale)`) in the message's language; both callers
(TeamLinkPanel: Admin › Members and the welcome invite step; GoalCard "초대 문구 복사") pass it; unit tests.
`teamLink.stepDesc` already says "send this message … it ends with the team link": unchanged, the line is in the message.
Out: guest and room invite messages (one-time personal links that already say "works once, until {date}"). No line
that asks people to forward the link onwards.

## Steps

1. en.ts key, then the other five locales.
2. `teamLinkMessage(t, { …, until })` puts the line right before the join line; callers pass the formatted expiry.
3. Update team-link, onboarding-polish and skill-share-member unit tests.
4. changes/team-link-message-shared-note.md; typecheck, check:i18n, unit tests, check:prepush.
5. Screenshots of the message preview (ko, en; 390 and 1440).

## Decisions

none

## Risks

Six languages need natural wording. The message grows by one line (max 7 lines + link).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit tests for team-link.

## Result

