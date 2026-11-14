# Composer send key: ↑ instead of ↵ on computers

- Date (UTC): 2026-11-14 15:09
- Branch: `fix/composer-send-arrow-up`
- Status: done
- Where: trina-ax/web. Why: the AI chat's message box is a core web component (see docs/REPOSITORY-RULES.md)
- Version impact: patch, an icon change on one button

## Goal

On a computer, the AI chat's send button shows ↵ (lucide `CornerDownLeft`). People, the owner too, do not read it as
"send". Show ↑ (`ArrowUp`), as phones, the room box and the ✦ side chat already do.

## Scope

In: `web/src/components/chat/Composer.tsx` send and send-answer buttons (Trina home, chats, project chats); the
Composer row in `docs/DESIGN-SYSTEM.md`; a unit test that send shows ↑.
Out: the button's size, colours and states stay; Enter still sends; SearchDialog's ↵ hints (they mean "press Enter").

## Steps

1. Swap the icon, keep `aria-label` / tooltip "Send".
2. Unit test, typecheck, i18n, web unit tests, composer and chat-send e2e specs.
3. Shots at 1440/390, light/dark: home, a chat, side chat, a room.
4. Changes fragment, PR to dev, CI, merge; then redeploy the /demo on ax.trina.app.

## Risks

None for data. The public demo is built from this web app, so its ring target must still sit on the send button.

## Result

Send and send-answer show ArrowUp on computers; classes and states unchanged. Unit test added; web unit, typecheck,
i18n, docs checks, composer/chat/side-chat e2e (117) and the demo walk pass. Shots at 1440/390, light/dark, looked at.
