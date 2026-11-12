# Links inside a quote are not links the person typed

- Date (UTC): 2026-11-12 01:23
- Branch: `fix/quoted-links-not-typed`
- Status: done
- Where: Team AX core, `server/src/tools/url-gate.ts` and `server/src/chat/read-rooms.ts`. Why: the web address gate
  and the "this chat has read rooms" rule are core chat security (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a security fix with no new setting or screen

## Goal

"Ask Trina about this" in a room puts another person's message into the asker's side chat as a Markdown quote (`> `
lines, web `SideChatPanel.tsx` `withQuote`). The web address gate reads every user message of the chat as typed by the
person, quote included, so a link written by someone else opened with no card and outside the link budget. After the
fix a link that appears only inside a quote is treated like any address the person did not type: the card asks first.
A link the person writes outside the quote (below it, in a later message) still opens without asking, as today.

## Scope

In: one shared rule for "quote lines" (a line that starts with `>`, spaces before it allowed), used by both the URL
gate's typed-address list and `quotesOnBranch` (which already treats those lines as other people's words).
Out: the other ways other people's words reach a chat are already handled: a shared project chat counts only the
asker's own messages (author check), a room AI session keeps the room context out of the stored message, and a file
quote carries a name and id, not text. No structured quote marker exists (the thread token is only on some quotes), so
the `>` prefix is the rule, the same one read-rooms uses.

## Steps

1. Export a `quoteLine` test and `withoutQuoteLines` from `chat/read-rooms.ts`; `quotesOnBranch` uses it.
2. `typedUrls` drops quote lines before collecting addresses.
3. Unit tests in `tests/unit/p0-webfetch-gate.test.ts`.
4. Changelog fragment `changes/quoted-links-not-typed.md`.
5. (Review) A display name with a line break ended the quote header early, so the rest of the name read as the
   asker's own line. `withQuote` writes the header (name, time, file name) as one line (`oneLineName`), and
   `PersonName` refuses control, separator and invisible characters with the room name rule (`shared/src/name-chars.ts`
   `NAME_FORBIDDEN`, now shared). The server answers that refusal in the person's language (`FIELD_MESSAGES`). Names
   saved before the rule still load.

## Risks

Every name-setting path (profile, `PATCH /api/me`, admin create and edit, invite, setup, CLI create-owner) uses
`PersonName`, so they all refuse the same characters. A person who quotes text themselves with `> ` and wants a link in it opened gets one card (a single yes remembers it
for the chat). That is the same reading read-rooms already makes of any quote. No migration. One new error text, in all five languages (`FIELD_MESSAGES`).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/p0-webfetch-gate.test.ts`,
`p0-exfil-server`, `b-chat-rooms`, `b-shared-chats`, `b-read-rooms-scheduled`, `a-auth`, `a-admin`, `b-rooms`,
`b-onboarding-profile`, web `side-chat`.

## Result

Built as planned. `chat/read-rooms.ts` exports `isQuoteLine` / `withoutQuoteLines`; `quotesOnBranch` and the URL
gate's `typedUrls` both use them. The new gate test fails without the fix. After review: names are one line in a quote and refused with a line break or
invisible characters (step 5). PR: see the branch's pull request to `dev`.
