# Steepling at the end of "Mina's first day" (free-roam demo content)

The free-roam demo lets a visitor try a real instance right after the scripted story (`scripts/demo/mina/`). The
instance must hold the story's END state, so this folder makes a demo content folder (format:
[`scripts/demo/company/README.md`](../company/README.md)) from the story's own words and pictures:

```bash
bun scripts/demo/steepling/make.ts --locale en|ko|ja|zh|es|id --out <dir>  # the content folder
bun scripts/demo/free-roam/build-snapshot.ts --content steepling --locale en --out <snapshots dir>
```

**Steepling is a fictional company.** Every person, number, address and file is made up; every address is a reserved
`.example` one. The pictures and avatars are the scripted demo's (`scripts/demo/mina/assets/`, see its README).

| Path | What |
|---|---|
| `make.ts` | `steepling(locale)` / `writeSteepling(locale, dir)`: company.json, files/, avatars/, fakes/ |
| `strings/<locale>.ts` (en, ko, ja, zh, es, id) | the words beyond the story: lived-in rooms and chats, the other teams, the CEO's folder, the fake Gmail and Drive, the bar's suggestions |
| `rich.ts` | the richer team, with no words: the three new people, three more projects and their channels, every new message and thread reply (sender, time, reactions, files, unread for Mina), the new chats, files, mail and Drive items, and the snapshot's floors (`FLOORS`) |
| `strings/rich.<locale>.ts` | its words, one flat record per language keyed by `rich.ts`'s ids (`satisfies RichWords`: a missing or extra line fails to compile). Korean is written fresh, not translated: 해요체 in chats, 개조식 in documents |
| `banner/` | the banner kit: `kit.ts` (written into the content folder by make.ts), `make-backgrounds.py` (the photos); `assets/banner/` holds them |
| `assets/skill-*.<locale>.md` | Steepling's own versions of four team skills (social-posts, competitor-roundup, handover, review-digest); brand-guide and press-release are the story's |

The cast, names, company, project, skills, files and pictures come from `scripts/demo/mina/strings/<locale>.ts` and
`assets/`, so they are the scripted demo's by construction (`tests/unit/demo-company-seed.test.ts` checks them).

## What the team holds

- **People** (10 accounts): Daniel Okoye (CEO) owns the team and is in Marketing; Mina, Sara, Leo, Ben Carter
  (designer, part-time) in Marketing; Tom, Nadia Rahman (customer care), Grace Kim (office and finance) in Operations;
  Aiko (Sales); Omar (Online shop). The demo person is Mina (`newHire`); the snapshot's demo file has her alone. Ben,
  Nadia and Grace have no photo (initials).
- **Projects**: the story's "Yuzu Ginger launch campaign" (channel Launch day), and Customer voice (Tom; reviews CSV and
  the October summary), Café partners (Aiko; the partner cafés CSV, the winter menu card), Social calendar (Leo; the
  calendar, the last six weeks of posts, hashtag rules). Each has its private channel and one shared AI chat.
- **Files**: the company intro (10 people), the team directory, three templates in `shared/<Templates>`, the summer
  retro and two meeting notes in Marketing's folder, the projects' files, six team skills that run with the demo's tools
  (no web), a file per other team, and `shared/Leadership/` (ko `shared/대표/`): only the CEO opens it.
- **Rooms** (times are minutes before the build; five weeks of history, Mina a member from each room's start, never
  "added"): #Everyone, #Marketing, Launch day, Customer voice, Café partners, Social calendar, Tea break, DMs with Sara,
  Leo, Daniel and Omar, and the handover group DM (Sara, Leo, Mina). About 140 messages, 10 threads, 24 replies.
- **Unread for Mina** when the visitor arrives: Sara's reply under her banner answer, Nadia's @Mina in Customer voice,
  Sara's reply in the Social calendar thread, and Omar's DM: Activity 1 (Sara's reply) + Chats › Mentions & threads 2
  (Nadia's mention, the Social calendar reply) + Omar's DM (QA TC-5700). Everything else is read.
- **Chats** (plain finished messages, no AI): Mina's "What does our company do?", "Who's who this week?", her banner
  chat and her ✦ side chat in #Marketing; Leo's and Sara's in the launch project; one in each new project.
- **Connections**: Mina's Gmail and Google Drive, the team's Higgsfield (auth none). Mina's welcome card says Sara
  invited her.
- **Home's suggestions** (`freeRoam.suggestions`, the chips above Home's message box, not in the bar): "Draft next
  week's posts", "Summarize customer reviews", "Did Chris reply?" (each language: the same in its words).
- **Dates**: no calendar dates and no launch-month names, not even for the launch (it is "Monday", the offer runs
  "two weeks"): the banners travel as files, so a date in them goes stale. Everything else is relative ("today", "last
  week"), so a snapshot built on another day still reads right. No day of the month either ("the 23rd", 23일, 23日). `tests/unit/demo-story-no-dates.test.ts` checks it.

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
    { "id": "media-plan", "name": "Fieldnote media plan, Yuzu Ginger launch", "mimeType": "application/vnd.google-apps.spreadsheet",
      "parent": "folder-1", "text": "Channel,Size,From,To,Budget\n…", "modifiedTime": "-9d" }
  ]
}
```

- `parent`: a folder's id (default: My Drive); `text`: what reading the file gives (a document as text, a sheet as CSV).
- `me` must be the account of a `google-drive` connection.

`fakes/higgsfield/`: pictures (png, jpg, webp) the fake Higgsfield answers with, picked by the words of their file
names (`00-yuzu-ginger-tea-pouch-…-유자-진저-…jpg`: `00-` so it sorts first and stays the default for a prompt no name
matches, with the story's words in English and Korean; `10-`, `20-`, `30-` the banner kit's other scenes).

`fakes/higgsfield/banner/`: the banner kit for the server's own `change_banner_text` (server/src/demo/fakes/banner.ts, banners.ts; never a Higgsfield tool), written by
`banner/kit.ts`. A banner is two layers, so a visitor can change its words and get a new banner back:

- a text-free photo per scene and size (`bg-<scene>-<size>.jpg`; `assets/banner/`, cut by
  `banner/make-backgrounds.py` from Higgsfield photos made once: one glass by the window = the story's photos, two
  glasses, the pouch close up (no square), a café table; the pouch's blank label is printed by the template);
- the words, `kit.json`: the story's banner words (`scripts/demo/mina/source/banners/copy.<locale>.json`), the launch
  banner's. The project folder also gets `banner.json`, the launch banner's words as a small file next to its pictures
  (make.ts): the AI reads it, edits the words with the normal file tools and calls change_banner_text, which draws every
  size from it (owner's demo test 11-22). Each scene's words pick it ("two cups", "두 잔" → two glasses);
- `fonts/`: Fraunces, Noto Serif KR and Noto Sans KR (SIL Open Font License 1.1, licences beside them), subset to Latin
  and the 2,350 common Hangul syllables; other letters fall back to the server's fonts.

typst draws it (the server's PDF converter), in the converters' isolation. The demo rule tells the AI the pictures come
from a prepared set and that it can change a banner's words with change_banner_text (server/src/chat/prompt.ts DEMO_BANNER_NOTE).

The Drive connection belongs to a Google client set up when it was made: the builder writes a made-up one to
`<base>/secrets/integrations/google-drive/client.json` before the server starts (nothing uses it; the fake answers
every Google address and no sign-in starts in the demo).
