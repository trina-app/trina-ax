# Copy link in the Share dialogs of chats and projects copies the page's own address

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/chat-share-copy-link (the owner, QA TC-3933)

- **Ask:** after sharing a chat with a group, the owner had nothing to paste to teammates: the chat's Share dialog had
  no link to copy. The file's Share dialog has **Copy link** at the bottom left. Do the same for chats and projects.
- **Rule:** **Copy link** sits at the bottom left of the chat's Share dialog (`components/chat/ChatShareDialog.tsx`, also
  read only and for a chat in a personal project), the project's Members dialog (`components/ProjectMembersDialog.tsx`)
  and the Share dialog of a personal project (`pages/Projects.tsx` ShareProjectDialog), the dialogs the header Share
  (`components/HeaderShare.tsx`) opens. One shared button, `components/ShareCopyLink.tsx`, which the file dialog now
  uses too, with the file dialog's words ("Copy link").
- **What it copies:** the normal in-app route on the team's address: a chat's `/c/<id>` (`chatLink`), a project's
  `/projects/<id>` (`projectLink`). The web and the desktop deep links open these already. No share-link id, no new
  endpoint, no new access path: the link opens only for people who can already see the chat or project.
- **Feedback:** the existing "Link copied" toasts. A chat uses the chat menu's copy (`useCopyChatLink`): "Link copied ·
  N people can open it", "· only you can open it" for a private ("Only me") chat, so a private chat shows Copy link with
  no misleading words. A project uses the file link's words: "Link copied. People with access can open it.", and for a
  personal project "Link copied. Only you can open it until you share it."
- **Unsaved picks:** the button always copies (the address does not change with a save). While people are picked and
  not saved, one short line above the buttons says so, naming the dialog's own button: "People you add can open the link
  after you press Share." (ko "공유 버튼을 누르면 추가한 사람도 링크를 열 수 있어요."). Why not copy only after the save:
  the link is the same before and after, and a disabled or deferred button would hide the answer to "what do I paste";
  one line is the simpler honest behaviour. The file dialog shows the same line while it has picks.
- **After Save:** the dialog closes as before; its toast ("Shared with 1 person", "Saved", "Saved." for members,
  "'Launch' is shared now.") carries a **Copy link** action, so "share, then send the link" is one flow.
- **No access:** someone who cannot see the chat gets the existing not-found page ("This chat can't be opened.", the
  same text as for an address that was never a chat); a project the existing "can't be found, or you don't have access"
  page. Neither shows the title, the creator or anyone in it. Tested on the server (the 404 body of a hidden chat or
  project equals a missing one's and holds no title or name: `tests/unit/b-share-copy-link.test.ts`) and in the browser
  (`web/test/e2e/share-copy-link.spec.ts`).
- **Left out:** a guest has no Share and no Members dialog on a project page, so no Copy link there (their own link is
  the page they are on). The members' share of a private chat in a team project (`ShareChatFlow`, a confirm only) keeps
  its toast as it was; the chat menu's Copy link covers it. The project list's "⋯ › Copy link" keeps its words.
- **Tests:** `web/test/unit/share-copy-link.test.tsx` (button, unsaved line, project copy and its words, every
  language); `web/test/e2e/share-copy-link.spec.ts` (1440 and 390: chat private / unsaved / saved toast / shared, owner
  and member project dialogs, guest page, not-found pages); `tests/unit/b-share-copy-link.test.ts`.
- **Version impact:** web only; no API, schema or protocol change.
