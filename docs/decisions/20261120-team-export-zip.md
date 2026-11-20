# The team export is a plain ZIP; the encrypted archive stays as the restore backup

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (the export part of the hosted spec §3.10.5 keeps its access rules)
- Branch: feat/export-plain-zip (trina-ax) and feat/export-plain-zip (trina-cloud)
- Ask (the owner, 2026-11-20, on the hosted console's "Export the whole team"): "이렇게 꼭 어렵게 해야하는거지?", then,
  after `age` said "incorrect passphrase" and "refusing to output binary to the terminal": "이거 되지도 않는데? 슬랙 레퍼
  삼아서 비슷하게 ㄱ". The coordinator decided to follow the common workspace-export pattern (request, mail when ready,
  one Download, a plain ZIP, a link that expires), in our own words and layout.

## What it was

The hosted team's owner (Trina Cloud console › the team › Settings › "Export the whole team"; only the account owner,
after a fresh mail code) asked for an export. The team server ran `admin.js archive --passphrase-random --upload`: the
database and the team folder as one `tar.zst`, age-encrypted with a random passphrase, uploaded to R2. The console
showed the link and the passphrase once, and every member got a notice. Opening it needed a terminal, the `age` CLI,
`-o` (or it refuses to print binary), the exact passphrase, `zstd` and `tar`, and then gave `db/app.sqlite` and
`team/`. Nobody outside the restore tool could read chats from it.

## Rule

1. **Download gives a normal ZIP** that opens with a double-click on macOS and Windows:
   - `README.txt`: what is where, the time zone, what is left out, "keep it safe".
   - `files/`: the team folder as people see it: `shared/`, `groups/`, `projects/`, `skills/`, and `people/<name>/` for
     each personal folder (by the person's name, not the account id).
   - `chats/Channels/`, `chats/Direct messages/`: one text file per conversation, by day, threads indented, a private AI
     answer marked "only <name> saw this"; files sent there in `<name> - files/` next to it.
   - `chats/AI chats/<person>/`: one text file per AI chat (the current branch of an edited chat).
   - `data/`: the same as JSON for another app: `people.json`, `conversations.json`, `messages/<id>.json`.
   - Left out: trash, older versions, backups (`.system`), folders tools make again (`node_modules` …), deleted
     messages and chats, chat attachments kept outside the team folder (their names stay in the text).
   - Text files are `.txt`, not `.md`: Windows has no default app for `.md`, so a double-click would ask which app.
   - Names are made safe for both systems (no `\ / : * ? " < > |`, no trailing dot or space, no device names, at most
     120 characters), and two names in one folder never differ only in case (" (2)").
2. **The ZIP is streamed** (`server/src/system/zip-out.ts`): deflate with data descriptors for files under 2 GiB
   (already-compressed types at level 1), stored with the real CRC in the header for bigger ones (Archive Utility
   refuses a stored entry with a descriptor; a file that changes between the two reads fails the export), zip64 for 4
   GiB files, offsets or 65,535 entries, UTF-8 names with the UTF-8 flag.
3. **Same access rules as before:** only the account owner requests and downloads, after re-auth; the link works 7
   days; the files are deleted after 14; the request, the download and the reveal are events in the audit log; every
   member is told once, on the first download of the ZIP or the first reveal of the backup, whichever comes first.
4. **The encrypted archive stays** behind one small link, "Encrypted backup (for restoring Trina AX)", with its
   passphrase shown once. It is what `restore-archive` reads. Its passphrase is now eight groups of five from
   `23456789abcdefghjkmnpqrstuvwxyz` joined by `-` (about 198 bits): no 0/O or 1/l/I to mix up, the dashes are part of
   it, and the console says to copy it with the button. The old one was base64url, where `-`, `_`, `l`/`I` and `O`/`0`
   are easy to mistype.

## Encryption at rest and in transit

Options considered:

- **A. The team server writes a plain ZIP to R2.** Simplest, but R2 then holds everyone's chats unencrypted for 14 days,
  and the CP could read them at any time. Refused.
- **B. The owner types the passphrase on Download; the CP decrypts the tar and builds the ZIP.** The passphrase is
  shown once and then deleted, so the owner must keep and type it, which is the step that failed. The CP would also
  have to unpack the database to disk to read the chats. Refused.
- **C. A ZIP made on demand by the team server while the owner downloads.** No channel streams a response from the
  team server through ax-hostd, and a canceled team's server is stopped. Refused.
- **D (chosen). The team server encrypts the ZIP to a one-time key of the CP; the CP decrypts it while streaming it to
  the signed-in owner.**
  - For each export the CP makes a new X25519 age key. Only its public half (`ExportInput.zip.recipient`) goes to the
    team server, which builds the ZIP from the same database copy as the archive and uploads `x/<team>/<export>.zip.age`
    to presigned URLs. R2 never holds a plain byte.
  - The secret half is sealed with the CP data key and the export id as additional data (`exports.zip_identity_enc`,
    the same store and envelope as the passphrase until it is shown). It is deleted when the link expires, when the
    export fails and when the team is deleted. Without it the object cannot be opened.
  - Download: `POST …/exports/:id/zip-ticket` needs the owner's session and a re-auth in the last 10 minutes and gives a
    random ticket (only its SHA-256 kept, in memory, 2 minutes, one use, tied to the user, team and export). The
    browser then opens `GET …/exports/:id/zip?ticket=…` over HTTPS with the session cookie. The CP streams R2 →
    age decrypt → the response (`application/zip`, `attachment`, `no-store`, `nosniff`). Nothing is written to the
    CP's disk. age checks each 64 KiB chunk and the end, so a cut or changed object fails the download. A browser link
    alone (no ticket) never starts a download or a member notice.
  - The CP could decrypt the ZIP while the key exists (7 days), as it could already open the archive while it held the
    passphrase before the reveal. That trust in the hosting service is the same as before. The team server already has
    the data.

## Compatibility

- `ExportInput.zip` and `ExportResult.zip` are optional (`shared/src/cloud-protocol/tenant-commands.ts`). A team
  server older than this ignores `zip` and answers without it. The CP then aborts the ZIP upload, drops the key and
  shows only the encrypted file, as before. ax-hostd passes stdin and stdout through, so it needs no change.
- The CP's vendored contract is pinned to an older trina-ax commit. Until it is re-pinned, the CP's command view
  (`src/vendor/cloud-protocol/tenant-commands.ts`) adds the same two optional fields.
- The part URLs on the command's stdin about double (one list per file). This is still far under mycel-ctl's 16 MiB
  stdin limit for any disk the plans sell.
- Tickets live in the CP process. A CP restart between the ticket and the download makes the person press Download
  again.

## Self-hosted servers

`trina_admin archive --zip --out <file.zip>` (admin.js) writes the same ZIP on an own server (mode 600, not encrypted, not for
`restore-archive`). See [docs/BACKUP-RESTORE.md](../BACKUP-RESTORE.md).

## Independent security review (2026-11-20)

Held up: owner-only routes with re-auth, the global Origin check on the ticket POST, ticket entropy, hashing, binding
and single use, no plaintext on the CP's disk, age's end-of-stream check, the passphrase generator, safe names.

Fixed in these PRs:
- A team file swapped for a symlink during a long export was followed. The ZIP now opens each file with `O_NOFOLLOW`,
  and the file must still be a regular file under the team folder.
- The sealed ZIP key went through the job payload, which a failed job keeps. It is now written straight to
  `exports.zip_identity_enc`, where every cleanup applies.
- The download sends `Content-Length` (age gives the plain size), so a cut download shows as failed.
- A HEAD request answers 405: a link preview does not use up the ticket or tell the members.
- `filename*` percent-encodes `' ( ) *`.
- Files uploaded to a channel but never sent stay out of the export.
- Removed people keep their name in `people.json`, but no email.
- Personal folders and other names under `users/` share one namespace, and `files/people/` is reserved first.
- Right-to-left and other direction marks are taken out of names.
- The members' notice now says that direct messages and AI chats are included.

Left as they were, for a follow-up:
- The restore archive's `tarStream` reads files the same way, following symlinks. It is older code, not part of this
  change.
- A failed export job keeps `passSealed` (the sealed passphrase) in its payload. Also older.
- The ZIP's part URLs last 6 hours, the same as the command's own time limit, so they add no new limit.
