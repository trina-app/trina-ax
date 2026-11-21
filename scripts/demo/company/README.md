# Demo company: the mechanism and its content format

`bun run demo:company` starts a development server for a **fictional company**, seeds it, and lets a viewer try the
product as one of three people (a new hire, a team lead, the CEO) on a phone on the same Wi-Fi. The scripts here are
the mechanism; the company itself is a **content folder** they read. The open example is
[`scripts/demo/acme`](../acme/README.md), the default.

```bash
bun run demo:company                                   # Acme (scripts/demo/acme), server 19830, relay 19831, data ~/.acmedemo
bun run demo:company --content <dir>                   # another company's content folder
MYCEL_DEMO_CONTENT=<dir> bun run demo:company          # the same, from the environment (--content wins)
bun run demo:company --local                           # this Mac only
bun run demo:seed --content <dir> --base <url>         # seed a running `bun run dev` instead
```

Options: `--port`, `--relay-port`, `--data <folder>` (default `~/.<id>demo`, kept between runs), `--local`, `--record`.

`bun run demo:trina` is the same script with `--require-content trina`: the 트리나 demo content is not in this public
repository (it is in the private `trina-ax-core`, `editions/trina/demo`), so it must be given with `--content` or
`MYCEL_DEMO_CONTENT`, and the script says where it is when it is missing.

What demo mode does on the server — the person switch, the replays, and every fence around them — is in
`docs/DECISIONS.md` ("Demo company: a new hire at 트리나", round 2, and "Demo content: the mechanism is open, a company's
content is a folder"). It is the same for every content folder: a content folder holds data, never code.

## The content folder

```
<content>/
  company.json     the company (below)
  files/           sample files at their team paths: shared/…, groups/<group>/…, skills/…, users/<username>/… (that
                   person's own files, uploaded by them)
  recordings/      recorded real answers, <scenario slug>.json (optional; record.ts writes them)
  assets/          optional: what the files are made from (generators, source pictures, their licences); never read
  README.md        what the company is, that every person and file is fictional, where its pictures come from
```

`company.json` is defined once, as `DemoContentCompany` in [`shared/src/api/demo.ts`](../../../shared/src/api/demo.ts),
and checked as a whole by [`content.ts`](content.ts) before anything starts: a folder that does not hold together stops
with a list of every problem instead of a half-seeded team.

| Field | What |
|---|---|
| `format` | `1` |
| `id` | short name (`acme`): the relay address `<id>.localhost` and the data folder `~/.<id>demo` |
| `teamName`, `locale` | the team's name and language (`ko`, `en`, `id`, `ja`, `es`); the content's own words are in it |
| `owner` | `{ username, name }`: the team's owner, an account of its own with a random password (`<data>/owner-password`, 0600), never a demo person |
| `people` | `{ username, name, group, note? }`, all members: the demo's password is public and it may be open to the network, so nobody else is an owner or an admin |
| `groups` | `{ name, description }`; each gets `groups/<name>/`, written by its members |
| `rules` | folder rules beyond the group folders: `{ path, rules: [{ group \| user \| everyone: true, access: read \| write }], limited?, why? }` (access adds up from the folders above; `limited: true` cuts what comes from above) |
| `uploaders`, `defaultUploader` | who uploads a sample file: the first `{ path, username }` whose path is the file or a folder above it, else `defaultUploader`, else the owner |
| `packSkills` | `{ pack, locale, skills }`: skills of this repository's skill packs (`resources/skill-packs/`), uploaded to `skills/<pack>/<skill>/SKILL.md` |
| `settings` | `aiSubagents`, `timeZone` (recordings need `aiSubagents: false`) |
| `memories` | `{ username, text }`: what a person's AI remembers about them |
| `profile` | the company profile (회사 소개), as `PUT /api/onboarding/profile` takes it |
| `demo` | `sameQuestion` and `personas`: `{ key: newHire \| lead \| ceo, username, intro, questions }` |
| `scenarios` | `{ slug, username, kind: showcase \| history, prompt, daysAgo? }`: prompts a demo person ran once with the real AI. A showcase prompt is suggested on that person's Home once its recording is there; a history one becomes a past chat `daysAgo` days ago |
| `checks` | `{ username, opens, closed, skills? }`: what the content promises, checked on a seeded app by `tests/unit/demo-company-seed.test.ts` |

What is checked on load: the JSON against the schema (unknown fields are refused), every person, group and account a
rule, uploader, memory, persona, scenario or check names; that the personas are members (never the owner); unique
names and slugs; at most six suggestions per persona; sample files only under `shared/`, `groups/<a group>/`,
`projects/<a project>/`, `skills/` or `users/<an account>/`; pack skills that exist; and every recording is a
`DemoRecording` of one scenario, by its person, with its prompt.

## Recording real answers

A recording is written down from Claude Code's own transcript of one real turn (`record.ts`); nothing is typed by hand.
On your own ports and data folder:

```bash
bun run demo:company --content <dir> --port 19832 --relay-port 19833 --data ~/.<id>demo-rec --local --record
bun scripts/demo/company/record.ts --content <dir> --base http://127.0.0.1:19832 --data ~/.<id>demo-rec/data [--only a,b]
```

A run that used a sub-agent, met a question from the AI, or did not finish is refused: make the prompt more decisive
and record that scene again. Scenes share one recording server, so a file one scene made can change the next answer;
delete it and record that scene again. Stop the server and delete the recording folder afterwards.

## Checks

```bash
bun test tests/unit/demo-company-seed.test.ts tests/unit/demo-company-record.test.ts      # the open example
MYCEL_DEMO_CONTENT=<dir> bun test tests/unit/demo-company-seed.test.ts tests/unit/demo-company-record.test.ts
```

With `MYCEL_DEMO_CONTENT` the same tests also seed that content and check its promises and recordings (each recorded
line in the team's language, for `ko` and `en`).

## The state a story ends in (free-roam demo)

A content folder may also say what the people did before the visitor came. All of it is optional (Acme has none);
[`story-state.ts`](story-state.ts) seeds it after the team, and the free-roam snapshot builder
([`../free-roam/build-snapshot.ts`](../free-roam/build-snapshot.ts)) runs both. The example is
[`../steepling`](../steepling/README.md).

| Field | What |
|---|---|
| `owner.group` | a group the owner is in too (a CEO who owns the team and is in #Marketing) |
| `owner.title`, `owner.email`, `people[].title`, `people[].email` | the job title and the e-mail on a person's profile, each set by them |
| `projects` | `{ name, instructions, by?, members: [{ group } \| { user }] }`: a team project `projects/<name>` made by `by` (default the owner); its files may be in `files/projects/<name>/`; `channel` (a `rooms` slug of a group chat with a name: only a private channel links) is linked to it by its maker |
| `rooms` | `{ slug, kind: all \| team \| dm \| group, group?, people?, name?, messages }`; a message is `{ from, text, minutesAgo, files?, reactions?, shareChat? }`, oldest first. In `text`, `{project:<name>}` is a link to the project, `{file:<team path>}` the file's address, `@<a person's name>` a mention; `shareChat` sends that chat's last answer to the room ("Send to room") with `text` as the note |
| `chats` | `{ slug, username, project?, sideRoom?, private?, title, turns: [{ ask, answer, minutesAgo }] }`: past AI chats as plain finished messages (no AI runs); in a project they are shared with its members, `sideRoom` makes the room's ✦ side chat. A shared project chat may have `thread: [{ from, text, minutesAgo }]`: replies under its last answer, `@<a person's name>` mentions them (the answer's asker and the people named get its notice in Activity). The builder dates the answers from the hidden-answers cutover on, so the project's members see them |
| `connections` | `{ service: gmail \| google-drive \| higgsfield, username?, account: { name, email } }`: a person's own Gmail or Drive, the team's Higgsfield, with made-up secrets |
| `welcome` | `{ username, inviter, asked? }`: who invited a person (their welcome card), and whether they asked what they can do |
| `fileTimes` | `[{ path, minutesAgo }]`: when files changed in the story (a file, or a folder for all under it; the first match wins), on disk and in Files › Recent |
| `recentHidden` | team paths whose seeding stays out of Files › Recent (the team skills, the company profile) |
| `freeRoam` | `{ suggestions: [{ label, prompt }] (1–3), signupUrl? }`: the free-roam bar's chips and where "Start free" goes |
| `avatars/<username>.jpg` | profile photos (png, webp too), each set by its person |
| `fakes/` | the fake Gmail, Drive and Higgsfield pictures (format: [`../steepling/README.md`](../steepling/README.md)) |

Every address in company.json and fakes/ must be a reserved `.example` one. The writes the public API cannot make
(times in the past of messages, thread replies and files, the inviter, connection rows, finished answers without the AI) go through the builder's routes
`/api/demo/builder/*` (`server/src/routes/demo-builder.ts`): the owner only, and only on a server whose demo file says
`builder: true`; 404 everywhere else, and never in a snapshot.

## The free-roam snapshot

```bash
bun scripts/demo/free-roam/build-snapshot.ts --content steepling|<dir> --locale en|ko --out <snapshots dir> [--name <n>] [--no-verify]
bun scripts/demo/free-roam/canary.ts --sealed <file> --snapshot <dir> [--instance <base dir>]…
```

The builder seeds a fresh development server on a whole base folder (no AI needed), stops it, deletes the setup token,
any owner password and every session and sign-in token, folds the WAL into the database, writes the free-roam demo
file (one person, `kind: "freeRoam"`, the fakes' folder) and a server.json with `engine.authMode: "managed"` and the
file list off. The result is `<snapshots dir>/<locale>/<name>/` with `manifest.json` (`codeVersion`, `locale`,
`createdAt`, `config`, `demoFile`, the content's id and hash, the git commit, the checks) and `base/`, the layout
`demo-gate/src/pool.ts` reads. Before it is moved there it is checked on a clone: it boots as the gate starts it, Mina
signs in through the persona switch, her files, skills, rooms and chats are there, nothing the AI did is counted, the
builder's routes are gone. The canary greps a snapshot or an instance's folder for the strings of a sealed file (the
real AI account's); it reports file and string number, never the string. Its leak prompts are a stub list, to be asked
on a clone only, never on a snapshot's base.
