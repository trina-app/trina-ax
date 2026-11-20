# Free-roam demo, PR C: Steepling end-of-story content, snapshot builder, canary

- Date (UTC): 2026-11-19 15:38
- Branch: `feat/demo-free-roam-c`
- Status: done
- Where: `scripts/demo/` (content, builder, canary), `shared/src/api/demo.ts` (format), `server/src/routes/demo-builder.ts`
  (builder-only routes). Why: the demo content and its tools are scripts; the server only gets the few writes the public
  API cannot make, behind the demo file's `builder: true` (see docs/REPOSITORY-RULES.md)
- Version impact: none (development and demo tooling; no user-visible change in a normal server)

## Goal

Visitors of the free-roam demo (plan: free-roam-demo-plan.md, owner OK 2026-11-19) arrive in a real instance right
after the scripted Mina story. The instance must hold the story's END state: Leo's banner improved in the Launch project,
Sara's DM with the project link, the CEO's OK in #Marketing, the mail to Chris in Sent, Daniel's shoutout in #Everyone.
This PR makes that team as data and builds the snapshot every instance is cloned from.

## Scope

In:
- `scripts/demo/steepling/`: makes a demo content folder (en, ko) from the scripted story's own words and pictures
  (`scripts/demo/mina/strings`, `assets`) plus the end state and a few lived-in rooms, chats and files; fake Gmail and
  Drive data (`fakes/gmail.json`, `fakes/drive.json`, format in its README).
- Content format, all optional: owner's group, projects with members, rooms with back-dated messages (reactions, an
  answer shared from a chat), seeded AI chats (plain messages, no AI), connections with fake secrets, the welcome
  inviter, `freeRoam.suggestions`. Acme stays valid and unchanged.
- Builder-only routes (`/api/demo/builder/*`, owner only, 404 unless the demo file says `builder: true`): back-date room
  messages, set the welcome inviter, make connection rows, write the turns of a seeded chat.
- `scripts/demo/free-roam/build-snapshot.ts`: seed a fresh server, scrub (setup token, owner password, sessions), WAL
  checkpoint, manifest, verify a clone (boot, sign in as Mina through the persona switch, checks).
- `scripts/demo/free-roam/canary.ts`: sealed account strings grepped in a snapshot and a running instance's data;
  leak prompts as a stub list.

Out: the freeRoam run kind and fences (PR A), the fakes themselves (PR B), the gate and web UX (PR D), hosting.

## Steps

1. Format in `shared/src/api/demo.ts` (separate block), checks in `scripts/demo/company/content.ts`.
2. Builder routes in `server/src/routes/demo-builder.ts`, registered from `routes/demo.ts` in one line.
3. `scripts/demo/company/story-state.ts`: seeds rooms, chats, connections, welcome and reads after `seedDemo`.
4. Steepling generator, strings en/ko, README with the fakes format.
5. Snapshot builder and canary.
6. Tests: `tests/unit/demo-company-seed.test.ts` (steepling en/ko, Acme unchanged), `tests/unit/demo-free-roam.test.ts`
   (snapshot hygiene, clone boots, Mina signs in); security matrix cases for the new routes.

## Decisions

None new: the content stays data ("Demo content: the mechanism is open, a company's content is a folder"); the builder
routes are the demo mode's, development servers only.

## Risks

- Builder routes write rows directly (connections, chat turns, room times): owner only, demo file `builder: true` only,
  which is itself refused outside development servers. The snapshot's demo file never has `builder`.
- Unix socket path length (103 bytes on macOS): clones go to a short temporary folder.
- Story deviation: reactions on Mina's #Marketing post come from Marketing's members (a room's reactions need its
  members; the scripted story used Tom, Aiko and Omar).

## Tests

`bun run typecheck`, `bun run docs:api`, `check:i18n`, `check:docs`, `check:prepush`, the demo unit tests under Bun 1.3.12.

## Result

Built as planned, with what PR A, B and the gate settled meanwhile:
- Snapshot layout is the gate's (`demo-gate/src/pool.ts`): `<out>/<locale>/<name>/{manifest.json, base/}`, manifest
  `codeVersion, locale, createdAt, config: config/server.json, demoFile: demo.json` (+ content id/hash, git, checks).
  server.json keeps `dataDir`/`teamRoot` relative to config/, `engine.authMode: managed`, `fileList.enabled: false`.
- The snapshot's demo file is PR A's `kind: "freeRoam"` with the one persona (Mina), `signupUrl`, and
  `freeRoam.suggestions` (also in GET /api/demo as `freeRoam`); `fakes: { content: "fakes" }` (PR B), relative to the
  instance's folder, where the gate and the builder start it. DemoFile here carries PR A's and PR B's fields verbatim,
  so their merge conflicts are textual only.
- Fakes follow PR B's shapes (`gmail.json` `{ me, messages }`, `drive.json` `{ me, files }`, `higgsfield/` pictures);
  Drive gets a made-up Google client in secrets/ before the server starts; Higgsfield is a team connection with auth
  none. Hygiene also refuses recorded proxy turns (PR A's limit counts them).
- The builder's routes live in `server/src/routes/demo-builder.ts` (route enumeration only reads routes/).
