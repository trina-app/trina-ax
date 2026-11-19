# Steepling at the end of "Mina's first day" (free-roam demo content)

The free-roam demo lets a visitor try a real instance right after the scripted story (`scripts/demo/mina/`). The
instance must hold the story's END state, so this folder makes a demo content folder (format:
[`scripts/demo/company/README.md`](../company/README.md)) from the story's own words and pictures:

```bash
bun scripts/demo/steepling/make.ts --locale en|ko --out <dir>           # the content folder
bun scripts/demo/free-roam/build-snapshot.ts --content steepling --locale en --out <snapshots dir>
```

**Steepling is a fictional company.** Every person, number, address and file is made up; every address is a reserved
`.example` one. The pictures and avatars are the scripted demo's (`scripts/demo/mina/assets/`, see its README).

| Path | What |
|---|---|
| `make.ts` | `steepling(locale)` / `writeSteepling(locale, dir)`: company.json, files/, avatars/, fakes/ |
| `strings/en.ts`, `strings/ko.ts` | the words beyond the story: lived-in rooms and chats, the other teams, the CEO's folder, the fake Gmail and Drive, the bar's suggestions |

The cast, names, company, project, skills, files and pictures come from `scripts/demo/mina/strings/<locale>.ts` and
`assets/`, so they are the scripted demo's by construction (`tests/unit/demo-company-seed.test.ts` checks them).

## What the team holds

- **People**: Daniel Okoye (CEO) owns the team and is in Marketing; Mina, Sara, Leo (Marketing), Tom (Operations), Aiko
  (Sales), Omar (Online shop). The demo person is Mina (`newHire`); the snapshot's demo file has her alone.
- **Files**: the company intro, the launch brief, the launch project with Leo's draft and Mina's launch set (banner,
  square, story, captions, the Higgsfield photo), five team skills that run (brand-guide, social-posts, press-release,
  competitor-roundup, handover), a file per other team, and `shared/Leadership/` (ko `shared/대표/`): limited, only
  the CEO (the owner) opens it.
- **Rooms** (times are minutes before the build): #Everyone with a week of history, the welcome lines and Daniel's
  shoutout with reactions; #Marketing with Leo's draft, Mina's banner answer sent to the room, the CEO's OK, Sara's Gmail
  hint and Chris's reply passed on; Sara's DM with the project link; Leo's DM; the "Launch day" group chat.
  The reactions on Mina's post come from Marketing's members (in the real app only a room's members react; the
  scripted story used Tom, Aiko and Omar).
- **Chats** (plain finished messages, no AI): Mina's "What does our company do?", her banner chat in the project, her
  ✦ side chat in #Marketing that sent the mail to Chris; Leo's and Sara's chats shared in the project.
- **Connections**: Mina's Gmail and Google Drive, the team's Higgsfield (auth none). Mina's welcome card says Sara
  invited her.
- **The bar** (`freeRoam.suggestions`): "Make next week's social posts", "Check Chris's reply", "What am I taking
  over?" (ko: the same in Korean).

## Fake Gmail, Drive and Higgsfield

`fakes/` in the content folder; the snapshot builder copies it to `<base>/fakes/` with every relative time made an ISO
time of the build, and the snapshot's demo file says `fakes: { content: "fakes" }` (relative to the instance's
folder, where the gate starts it). The server's fakes read it (`server/src/demo/fakes/`, decision
`docs/decisions/20261119-demo-fakes.md`); the shapes are checked here by `shared/src/demo-fakes.ts`.

`fakes/gmail.json`: one mailbox.

```json
{
  "me": { "name": "Mina Lee", "email": "mina.lee@steepling.example" },
  "messages": [
    { "id": "chris-reply", "threadId": "launch-banner", "from": "Chris Walker <chris.walker@fieldnote.example>",
      "to": "Mina Lee <mina.lee@steepling.example>", "cc": "Sara Jensen <sara.jensen@steepling.example>",
      "subject": "Re: Final banner for Monday's launch", "date": "-110m", "body": "…", "labels": ["INBOX", "UNREAD"] },
    { "id": "to-chris", "threadId": "launch-banner", "from": "Mina Lee <mina.lee@steepling.example>", "to": "…",
      "subject": "Final banner for Monday's launch", "date": "-123m", "body": "…", "labels": ["SENT"],
      "attachments": ["launch-banner-new.jpg", "instagram-square.jpg"] }
  ]
}
```

- `date`: an ISO time, or `-<n>d` / `-<n>h` / `-<n>m` (n at most four digits) before the build.
- `labels`: Gmail's (`INBOX`, `SENT`, `DRAFT`, `UNREAD`, `IMPORTANT` …); default `INBOX`, or `SENT` for mail from `me`.
- `attachments`: file names of the content's files (the launch set in the project).
- `me` must be the account of a `gmail` connection in company.json.

`fakes/drive.json`: one Drive.

```json
{
  "me": { "name": "Mina Lee", "email": "mina.lee@steepling.example" },
  "files": [
    { "id": "folder-1", "name": "Fieldnote", "mimeType": "application/vnd.google-apps.folder" },
    { "id": "media-plan", "name": "Fieldnote media plan, November", "mimeType": "application/vnd.google-apps.spreadsheet",
      "parent": "folder-1", "text": "Channel,Size,From,To,Budget\n…", "modifiedTime": "-9d" }
  ]
}
```

- `parent`: a folder's id (default: My Drive); `text`: what reading the file gives (a document as text, a sheet as CSV).
- `me` must be the account of a `google-drive` connection.

`fakes/higgsfield/`: pictures (png, jpg, webp) the fake Higgsfield answers with, picked by the words of their file
names (`yuzu-ginger-tea-pouch-iced-glass-frosted-window-morning-light.jpg`).

The Drive connection belongs to a Google client set up when it was made: the builder writes a made-up one to
`<base>/secrets/integrations/google-drive/client.json` before the server starts (nothing uses it; the fake answers
every Google address and no sign-in starts in the demo).
