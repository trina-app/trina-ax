# An app on the computer attaches a team file through a one-time link

- Date: 2026-11-28
- Status: accepted
- Supersedes: "apps on the computer such as Aside still cannot attach" of
  [20261126-browser-file-upload.md](20261126-browser-file-upload.md) and the same rule in
  [20261126-shared-chat-own-tools.md](20261126-shared-chat-own-tools.md); the last sentence of ATTACH_HOW in
  [20261116-mail-attach-team-file.md](20261116-mail-attach-team-file.md)
- Branch: fix/aside-attach-team-file (the owner, 2026-11-28: "이전에는 잘 했는데?")

- **Ask:** the owner had Trina write a reply in Daum web mail through Aside with a team quote PDF attached. Trina said
  Aside cannot fetch team files, so the PDF cannot go in the attachment field. The in-app browser does it (file_upload);
  Aside's repl can too: it has `fetch`, `Buffer` and Playwright's `setInputFiles`.
- **Why it failed:** Trina's own rule, not Aside: ATTACH_HOW told the AI it cannot, and a `team-file:` handle in Aside's
  code or task was refused (`refused (attachment: app on the computer)`). Aside's permission mode played no part.
- **Rule, what the AI writes:** in the code or task of an app on the computer (Aside's repl and exec, ego lite's
  script), `"team-file:<path>"` in quotes (", ' or `) where it downloads the file, e.g.
  `const r = await fetch("team-file:shared/q.pdf")`, then `setInputFiles([{ name, mimeType, buffer:
  Buffer.from(await r.arrayBuffer()) }])` (a list: Aside's repl refuses a single object). The whole value of an argument
  that is not a file's content gets a link too; a file's content argument still gets base64. A handle in the middle of a
  text without quotes, or a quoted one whose path has a backslash or `${`, is refused with how to write it (where it
  ends cannot be told, or the code after the swap would not be the code on the card). The same handle twice is one link. ATTACH_HOW_LOCAL says this only
  where such an app is offered in the answer (the resumed-session context budget of ATTACH_HOW is unchanged).
- **Rule, the files:** the mail attachment's path, unchanged: read as the person of the turn
  (`readOutgoingTeamFiles`: read permission, no folder, the safety check, the same file twice, 20 files and 18 MB, a
  stored connection key inside), a shared chat's read check, the connection's card naming each file (the code on the
  card keeps the handle), the files checked again after the card. Only a tool that changes something; never in a
  scheduled run.
- **Rule, the link:** made after that last check (`local-file-links.ts`, held by the local relay): 32 random bytes, in
  memory with the exact checked bytes, one download, gone after 10 minutes or when the turn ends (any end, a normal one included: `LocalRelay.cancelTurn`), at most 200 MB waiting
  on the server. `GET /team-file-links/<token>` (outside /api: the app on the computer has no sign-in of the team page):
  the file checked again (access now, unchanged, not held), the type from the extension, `attachment` with the UTF-8
  name, `no-store`, `nosniff`, a sandbox CSP; every failure the same 404. Audited (`local_app.file_link`: path, size,
  hash; never the token); the path is masked in the request log.
- **Rule, the address:** the team page origin the desktop window connected from (its WebSocket's checked Origin), where
  that computer reaches the server; else the first configured public origin; else refused in plain words.
- **Rule, the AI never sees a link:** the call it sees and the card keep the handle; the app's answer, and a failure it reports, get each
  link put back as its handle, and a token written any other way is masked.
- **Why this is enough (lean security, owner 2026-11-19):** the file goes to the person's own app on their own computer,
  only a file they may read, only after the card (or their Always allow), single use and short-lived: what their own
  download and pick would do. No permanent or public link.
- **Left out:** a download into Aside's own folder by the desktop app (needs a desktop release); folders.
- **Tests:** `tests/unit/c-local-file-links.test.ts`, `tests/unit/c-local-apps-shared.test.ts` ("a team file handed
  to an app on the computer"), `tests/unit/server-app.test.ts`.
- **Version impact:** minor (a new ability of the Aside and ego lite connections and a new route).
