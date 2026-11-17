# The disk filling is a kept notice for the owner and admins; a refused file in a conversation says who can help

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (adds to the storage levels of docs/DECISIONS.md "클라우드 리눅스 서버": the 80% toast stays)
- Branch: feat/storage-full-notices (the owner: "go similar to Slack, go"; plan "Files sent in conversations, like
  Slack", phase P2)

- **Ask:** a team's disk is small and conversation files can now be 1 GB each. From 80% the owner and admins got a
  toast once a day, but only the ones online at that moment; nothing was kept. And a file refused for a full disk told
  everyone "The storage is full. Empty the trash or clean up files.", which a member or guest cannot do.
- **Rule 1, the notice:** from 80% (the plan's view, the percent the storage card shows) each active owner and admin
  gets a notice kept in **Activity** (`storage.filling`, table `storage_notices`, migration 702), and again from 95%. At
  most once per 24 h per threshold, kept in the settings table (`system.storageNoticeAt.80` / `.95`); a 95% notice also
  holds back the 80% one, so a dip to 90% the same day says nothing new. A new notice marks the person's older unread
  one read: a disk full for days is one unread row, not one a day. It says "Storage is 82% full. Files in conversations
  take 31 GB. See what uses the space." (the number only once measured) and opens Admin › System › Storage.
- **Who:** owners and admins only, never a member or guest (they cannot free the space; Slack has no such state for
  them). Someone demoted since reads the plain "The team's storage is nearly full." with no number and no link.
- **Shown always, Activity only:** no setting (like the hosting and engine notices, so Settings › Notifications gets no
  new row, unlike the parent plan's case 10), no phone push, no e-mail. Not in the Activity "Requests" filter: nothing
  waits for an answer. The live toast and its `storage.warn` audit stay as they were; an admin who is online at 80%
  sees both.
- **Rule 2, the refused file:** in a conversation's box (a file from this computer, and a team file copied in), a
  refusal for space (507 `storage_full`, or an upload session's 413 with the new `reason: 'disk_full'`, which also
  carries the plan's page now, since on a small disk its 1 GB margin can come before the guard's reserve) reads:
  - member or guest: "There isn't enough space on the team's storage for this file. Ask an admin to free some space."
  - owner or admin: "There isn't enough space on the team's storage for this file." then **See what uses the space**
    (Admin › System › Storage) and, on a hosted team, **Choose a plan**, in the same line of text so a phone's chip
    wraps them.
  "Isn't enough space for this file", not "is full": the guard refuses one write that does not fit, and a smaller file
  may still go. The shared `storage_full` sentence stays for the other places (Files, AI chat attachments).
  The 413's plan page shows as "Choose a plan" everywhere a refused upload shows it (`StoragePlansLink`: Files rows,
  folder uploads, chat attachments), as a 507's did.
- **Changed from the plan:** "Ask {owner's name}" became "Ask an admin": the page has no owner's name for a member or
  guest, and "Ask an admin" is what other member screens say.
- **For the next step:** the table's CHECK already lists `storage.cleanup` and it has `by_user` ("Ask people to clean
  up"), so that step needs no new table. `by_user` has no foreign key; account removal lists it as kept.
- **Tests:** `tests/unit/g-storage.test.ts` (owner and admin only; once a day; 95% the same day; a dip after 95% says
  nothing; a day later again; one unread; the rooms number; the link; demoted reader), `a-account-removal-coverage`,
  `web/test/unit/storage-full-notices.test.tsx` (words and link; role words; 507 / 413 disk_full / 413 too-big; the plan
  link on the 413).
- **Version impact:** minor (migration 702, additive, reader 1). An open tab older than the server reads the Activity
  list with the old list of kinds and fails until it reloads, which it does by itself when the server reports its new
  version (components/Layout.tsx UpdateWatcher).
