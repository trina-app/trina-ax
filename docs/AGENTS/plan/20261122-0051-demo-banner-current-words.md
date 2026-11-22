# Demo banner: the words are a file the AI reads and edits, the tool draws from it

- Date (UTC): 2026-11-22 00:51
- Branch: `fix/demo-banner-current-words`
- Status: done
- Where: server (demo fakes, change_banner_text, the demo note in the AI's instructions) and the Steepling seed. Why:
  the owner's live ko demo test of 11-22 (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a demo-only fix of the AI's banner edits

## Goal

In the 유자 진저 project chat the launch banner says "흐린 아침에, 작은 햇살 한 잔.". The owner asked "흐린 아침 말고,
밝은 아침으로 해줘". The AI took it as a request for a new scene photo, then rewrote the whole headline with made-up
words, then said it did not know the original words. It took four messages to get "밝은 아침에, 작은 햇살 한 잔.".
After this change the first message gives that headline.

Root cause: the AI never saw the banner's current words. They lived only in the server's state and in an earlier tool
result. change_banner_text took whole fields as arguments, so a partial edit meant retyping words it did not know.

## Scope

In (owner's direction, 11-22: do it the way plain Claude Code would, read the file, edit the words, render):
- Each banner has a small text source next to its pictures: `<project folder>/banner.json` (headline, subline,
  eyebrow, badge, badge_note, button, scene, sizes; one field per line). The seed writes the launch banner's.
- The AI changes words with the normal read and edit tools on that file; "흐린 아침 말고 밝은 아침" is a one-word edit.
- change_banner_text draws every size from the source and saves the pictures next to it. With no source yet, it makes
  one from the launch banner. The old word arguments still work: they are written into the source first.
- The demo note names this chat's source file (the project's, else the person's own folder) and says to read it
  before changing words. It also says that words on the banner make a text edit, never a new-scene request.

Out: the hosted demo itself (deployed separately). The first version of this plan's `replace` mode was dropped for
the source file.

## Steps

1. banners.ts: the source format (BannerSourceFile, bannerSourceText, parseBannerSource, launchSource); a scene id
   in `scene` picks that scene.
2. tools/demo-banner.ts: read the source (or make it), draw every size, save, update the source when arguments changed
   it; bannerSourceFor for the note.
3. prompt.ts DEMO_BANNER_NOTE + demoBannerSource; turn.ts passes the source path.
4. Seed: steepling make.ts writes `projects/<project>/banner.json`.
5. rooms/ai-tools.ts: change_banner_text writes several files ('many') and `source` is a write target too.
6. Tests: the owner's transcript as read → edit → render in one turn; per-project source; broken source; seed; note.

## Decisions

none

## Risks

Demo only (the tool and the note exist only on a demo server with a banner kit). A demo already seeded has no
banner.json: the first call makes it from the launch banner.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, tests/unit/*demo*.test.ts,
b-shared-save-card, the prompt tests.

## Result

Built as above. One render draws all three sizes, saves them next to the source, and shows them inline.
