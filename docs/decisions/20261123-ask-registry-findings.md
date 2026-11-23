# Ask registry findings: Always holds where it was ignored; kept exceptions

- Date: 2026-11-23
- Status: accepted
- Supersedes: none (closes the "Findings" of [docs/ASKS.md](../ASKS.md); applies
  [20261116-always-allow-final-rule-a.md](20261116-always-allow-final-rule-a.md))
- Branch: fix/ask-registry-findings (the owner decided each item under Rule A; there is one Always per person)

- **Ask:** the first ask inventory (docs/ASKS.md, decision 20261122-ask-registry) found four places where the person's
  own "Always allow" was not read in their own scheduled run, fourteen open questions, and a few smaller problems.
- **Rule (Always holds):**
  - In the person's own scheduled run, a tool reads their Always before it refuses because nobody is watching
    (`TurnPerson.alwaysOn`, `askConfirm`). This covers moves, copies (also after a room read), downloads over 1 GB and AI
    video. The daily video limit still applies.
  - **1.** With Always on, deletes (to the trash) and skill-folder changes run in shared chats and in chats other
    people wrote in, and after a room read in a scheduled run.
  - **2.** With Always on, project members and folder access changes run in the person's own scheduled run, in shared
    chats and in chats other people wrote in. In a shared chat the tool is offered only while that Always is on
    (`SHARED_UNDER_ALWAYS`). Every check of who may change what stays: an owner or admin for folders, a project manager
    for members, the folder as the person sees it, the person or group named, and the live account. A guest is always
    refused. Only the person's own Always counts.
  - **3.** AI video: as above.
  - **6.** The connector send Always (the person's own connection set to send without asking, or their own row on a
    team connection) is listed in Settings › 트리나에게 허용한 것 (`connector_send`, id `send:<connection>`) and can be
    removed there. The team's own rule (an admin's) is never changed there.
  - **8.** The desktop app's in-app browser sites stay on the device. In the desktop app, 트리나에게 허용한 것 also lists
    them, with Remove.
  - **9.** Settings › 커넥터 in the desktop app lists the local programs connected on this computer, with Remove (the
    next call asks again).
  - **10, 11, 13, 14.** The edit or regenerate confirm is now a one-line notice. A restore that drops nobody else's
    edits has no confirm. The setup "skip invite" confirm is gone. Office preview links open in a new tab with no
    confirm.
  - The skill-save Always says what it covers ("Always allow skill saves"). A full dev-site list (2,000) offers no Always
    and says so; it never turns "Always" into "once" without saying. The office-network address card follows the team's
    Always switch.
- **Kept exceptions (not violations; do not re-raise):**
  - `schedule.create` has no Always: every task runs when nobody is watching and may send. The card says it shows every
    time.
  - `share.folder.stop`, `unshare.files` have no Always: stopping a share only narrows access, can be undone, and asks
    nothing when the message names it.
  - `conn.write.noalways`: in a shared chat, a connector send to other people asks every time
    (decision 20261122-connector-always-allow).
  - `ui.share.chatFiles`: "Share the files too" starts unticked (decision 20261121-share-chat-files).
- **Version impact:** minor. Settings lists more, and the desktop bridge has two optional calls; older apps still work.
