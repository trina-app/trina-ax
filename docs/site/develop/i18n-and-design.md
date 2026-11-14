---
title: Languages and design
description: Six languages for every app string, and the design system every screen follows.
---

## Languages

The app speaks English, Korean, Indonesian, Japanese, Spanish and Simplified Chinese. Every app-owned string must exist in all six.

| File | Language |
|---|---|
| `web/src/i18n/en.ts` | English |
| `web/src/i18n/ko.ts` | Korean |
| `web/src/i18n/id.ts` | Indonesian |
| `web/src/i18n/ja.ts` | Japanese |
| `web/src/i18n/es.ts` | Spanish |
| `web/src/i18n/zh.ts` | Simplified Chinese |

- Plurals use ICU messages. Japanese, Spanish and Chinese keep both `one` and `other` forms, as English has them.
- Run `bun run check:i18n` after any UI or server copy change.
- Write naturally in each language. Do not translate word by word.

## Design system

Every screen follows [`docs/DESIGN-SYSTEM.md`](../../DESIGN-SYSTEM.md): colours, type, layout, components, copy and accessibility.

| Rule | In practice |
|---|---|
| Calm screens | Short titles, one-line descriptions, small status chips instead of sentences |
| Theme tokens | Use the theme's colour tokens, never fixed colours, so light and dark both work |
| Phone width | Every screen works at phone width |
| Accessibility | Keyboard reachable, visible focus, labels that match visible text, contrast that passes axe |
| Copy | Plain words, short sentences, the same word for the same thing |

Trina's colours and logo live in `editions/trina/branding/` and are applied at build time.
