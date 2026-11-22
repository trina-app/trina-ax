# Chat share dialog: half the words, every safety fact kept

- Date (UTC): 2026-11-22 03:00
- Branch: `fix/share-dialog-lean`
- Status: in progress
- Where: web/ (ChatShareDialog, ShareWarning, i18n). Why: the owner on the chat Share dialog: "too much text?"
- Version impact: patch: wording and layout of one dialog; no API, behaviour or permission change

## Goal

The chat Share dialog reads in one look. Today it stacks a two-bullet warning box, a separate grey "couldn't check"
line, a files box of three sentences, a long fixed note and a footer sentence about the link, then three buttons.

## Scope

In (components/chat/ChatShareDialog.tsx, components/ShareWarning.tsx, the 6 locales, tests):
- Warning box: one line "Some answers used places {names} can't open · your personal memories, groups/x/, My files"
  and "Show answers ›"; the "older answers couldn't be checked" line goes into the same box as a short second line
  when there is a box (still a grey line when there is none). No bullets.
- Files step: one checkbox row "Share the files too (n)", the files with their place under it, one small hint "The chat
  gets copies. Your originals stay put."; the deletion detail moves to the hint's tooltip.
- The long fixed note and the footer's "People you add can open the link after you press Share" become one short line
  under the people list: "People you add see the whole chat and can ask the AI in it."
- Buttons: Copy link | Cancel | Share (Save on a chat already shared). The checkbox decides whether the files go;
  "Share without files" / "Share with files" go.

Out: the project members' share (ShareChat.tsx) and the access-request notice keep their sentence lines; the line
about earlier attached files ("n files you attached will be visible") stays a line of its own (security review of
#976).

## Steps

1. ShareWarning: a `compact` mode (summary line + sources + optional unchecked line), used by the chat dialog only.
2. ChatShareDialog: checkbox files row, one footer, one short note under the people list, no link-after-save line.
3. i18n keys in en first, then ko, ja, zh, es, id; drop the keys nothing uses any more.
4. Unit + e2e tests that pin the old strings and buttons.

## Decisions

- The files checkbox starts **unticked**. Today there is no tick: the owner picks one of two buttons, so a file never
  leaves My files without a press that names files (decision 20261121-share-chat-files Rule 2). A pre-ticked box under
  a plain "Share" would copy files by a press that does not name them; unticked keeps that rule.
- Server, API calls, confirm keys, hidden-answer and file-visibility rules: unchanged.

## Result

(filled in at the end)
