# The AI page is named as the app shows it everywhere: Admin › Connections › AI accounts

- Date (UTC): 2026-11-12 00:56
- Branch: `fix/docs-ai-page-names`
- Status: done
- Where: install guides and docs, server messages (server/src/admin/engines.ts, server/src/system/messages.ts), the Drive public-address hint (web i18n). Why: wording (QA TC-211 part 3; TC-196 review note)
- Version impact: patch, wording only

## Goal

The admin page for AI connections is "AI 계정 / AI accounts" in the "연결 / Connections" group, but the English Linux
guide, the Docker guide, TROUBLESHOOTING, PERMISSIONS, TRY-IT, INSTALL and the server's own messages (5 languages)
still sent people to "Providers / 제공자". The Drive hint also named an install-guide step "인터넷 주소" that the guide
calls "공개 주소".

## Result

Server messages (engines.ts 10 strings, messages.ts 15 strings over 5 languages), 7 docs and the Drive hint (5 languages)
changed. Checks: typecheck, check:i18n, check:docs, the 8 test files that cover these messages.
