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
  files/           sample files at their team paths: shared/…, groups/<group>/…, skills/…
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
| `rules` | folder rules beyond the group folders: `{ path, rules: [{ group \| user \| everyone: true, access: none \| read \| write }], why? }` (the deepest folder with a rule for a person decides) |
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
names and slugs; at most six suggestions per persona; sample files only under `shared/`, `groups/<a group>/` or
`skills/`; pack skills that exist; and every recording is a `DemoRecording` of one scenario, by its person, with its
prompt.

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
