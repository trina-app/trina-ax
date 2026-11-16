# A member can share a folder in their own files (server; behind a gate until the web part)

- Date: 2026-11-16
- Status: accepted
- Supersedes: parts of [Share like Google Drive (P1)](../DECISIONS.md#%EB%93%9C%EB%9D%BC%EC%9D%B4%EB%B8%8C%EC%B2%98%EB%9F%BC-%EA%B3%B5%EC%9C%A0-p1--share-like-google-drive-one-dialog-featshare-like-drive-p1-2026-11-14-product-owner-qa-tc-13051312), [Folder access adds up like Google Drive (P2)](../DECISIONS.md#folder-access-adds-up-like-google-drive-p2--%ED%8F%B4%EB%8D%94-%EA%B6%8C%ED%95%9C%EC%9D%B4-%EB%93%9C%EB%9D%BC%EC%9D%B4%EB%B8%8C%EC%B2%98%EB%9F%BC-%EC%9C%84%EC%97%90%EC%84%9C-%EB%8D%94%ED%95%B4%EC%A7%84%EB%8B%A4-featfolder-access-additive-2026-11-14-owner-decided) and [A member shares their own files](../DECISIONS.md#a-member-shares-their-own-files--%EB%82%B4-%ED%8C%8C%EC%9D%BC%EC%9D%84-%EA%B3%A0%EB%A5%B8-%EC%82%AC%EB%9E%8C%EA%B3%BC-%EA%B3%B5%EC%9C%A0-featfile-share-links-2026-11-15-the-owner-qa-tc-3093), as quoted below
- Branch: feat/folder-share-server (the owner approved the design on 2026-11-16; QA TC-4077..4089, TC-4099..4105)

Design: `docs/AGENTS/plan/20261116-1147-folder-sharing.md` (branch `plan/folder-sharing`, revision 2, after a security
review). Plan of this part: [20261116-1224-folder-share-server.md](../AGENTS/plan/20261116-1224-folder-share-server.md).

- **Ask:** a person shares a folder in their own files with teammates or groups, like a folder in Google Drive's My
  Drive: the folder itself is shared, files added later follow, view only, and the person can stop at any time.
- **What the older decisions said, and what changes:**
  1. P1: "no "Copy link" (no per-folder link), members do not share", amended: "members do not share **folders**; a
     member shares a **file** they own … "No Copy link" stays for folders." **Changes:** a member shares a folder
     **inside their own files**, and that folder has a link. **Stays:** members do not share **team** folders, and a
     team folder has no link.
  2. P2: "only the owner and admins share and turn Limit access on or off; no Commenter, no notify box, no links,
     folders only". **Stays for team folders.** A personal folder share is not a folder rule and is not part of the
     additive rule model.
  3. "A member shares their own files": "Never a folder, never a guest, never oneself; a member adds only their own
     groups. View only". **Changes:** "never a folder" becomes "never a **team** folder by a member, never the personal
     folder itself or a place the server keeps". **Stays:** never a guest, never oneself, own groups only, view only.
  4. Same: "`RuleSet.decide` is not changed: grants are read only by the id endpoints … no versions, history, extracted
     text, path, folder or neighbours." **Stays:** the folder rules are not changed (users/<id>/ carries no rules, so
     by path another person's folder stays closed to everyone, admins included); no versions, history, text or search.
     **Changes:** for a shared folder the id endpoints also list the names inside it and serve the current bytes of the
     files inside it.
  5. Same: "users/<id>/ stays private to its person by path (admins too); a shared file opens only by its link."
     **Stays**, and a shared folder opens only by its link id, for the people on it.
- **Rule: what may be shared.** A folder at users/<me>/<name>/… (depth 3 or deeper). Never the personal folder itself,
  never a place the server keeps or anything inside it: skills, projects, downloads, images, videos, exports,
  .attachments, notes.md, "From this computer", the archived-accounts folder in every language, a hidden or temp name,
  a skill root, a project's folder or a folder holding or inside one. Names are compared case-, width- and
  Unicode-folded, and each list is read from the constant its writer uses. Checked when sharing and on every open.
- **Rule: which folder.** The share remembers the folder's identity on disk (device, inode, creation time). On a disk
  that keeps no creation times a folder cannot be shared ("Folders can't be shared on this server's disk"). When the
  folder at the path is no longer the one shared (replaced outside the app, a new folder made where it was), the share
  is **paused**: nobody opens it, the people on it are kept, the owner is told and resumes it. Nothing is deleted. Only
  the device number changing (a remount, a move to another host) is the same folder.
- **Rule: opening.** By the link and a path inside the folder, resolved as the owner through the normal permission
  walk, checked for syntax first and for staying inside the folder after. Hidden, temp and refused names, links, hard
  links, project folders and kept places inside are never listed or served. A file's bytes come from the one
  descriptor that was checked (its inode and device must equal the checked file's). One level a call, 200 entries a
  page, at most 2,000 entries read; list, entry and download share one budget of 240 a minute per person.
- **Rule: nested shares add up.** A person passes when a live, unpaused share at or above the path reaches them; each
  share that grants is checked like the one opened.
- **Rule: stopping is always the owner's.** Taking people off and Stop sharing never ask the team switch, for files as
  well as folders (before, with the switch off an owner could not remove their own file's people). Adding still does.
- **Rule: Undo.** A removal stores what it took and can be undone once, by the person who removed, within 10 minutes:
  the grants still valid come back with their old giver and way, dated at the undo (they had no access in between, so
  a restore's "who could see it then" does not count them for that gap), quietly; the team owner's "Remove all file
  shares" closes every earlier undo.
- **Lifecycle:** a rename or a move inside the owner's files keeps the link and the people; a move out of the owner's
  files or into a kept place ends it (the owner is told); trash parks it, restore brings it back, purge deletes it; a
  group's delete removes its entries from files and folders; an owner turned off shares nothing until back; removed:
  the rows go, and the archive their folder lands in is never shared.
- **Gate:** none of this is reachable by people until the web part opens `config.folderShares` (no config key or
  environment variable sets it). It opens only after the widening checks are merged.
- **Left out here** (later parts of the design): counting share readers where "more people will see this" is decided,
  the dev environment's write refusal, the AI's tools, the screens. The design's shared-files mark
  (`chats.shared_files_seen`) is not built: the `chats.others_words` mark (migration 410, the #1109 batch) replaces it.
- **Version impact:** minor (migration 360, additive; new endpoints).
- **Tests:** `tests/security/folder-shares.test.ts`, `tests/unit/c-share-places.test.ts`.
