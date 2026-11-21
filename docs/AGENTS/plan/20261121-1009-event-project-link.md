# Event lines name a project as it is now: renamed, in the trash, no access, deleted

- Date (UTC): 2026-11-21 10:09
- Branch: `fix/event-project-link`
- Status: in progress
- Where: server/src/rooms (the resolver), shared/src/api/rooms.ts (an optional field), web/src/lib/rooms.ts and
  web/src/components/rooms/RoomMessages.tsx (the line). Why: a room's project event line showed a dead or misleading
  project link (a follow-up from 2026-11-20).
- Version impact: patch (a fix to how existing lines read; one optional response field, no migration, no new endpoint)

## Goal

A room event line that names a team project ("… linked this channel to the project Y", "This channel is now the chat
room of the project Y", and the lines that follow them) should never send a person to a project that is not there for
them. It reads the project at render time, for that viewer:

- the viewer can open it: its current name, a link to it;
- it is in the trash and the viewer is one of its people: "Y (in the trash)", plain text, no link;
- the viewer cannot open it (never could, or no longer can): "a project", plain text; a renamed name never reaches them;
- it was deleted for good: "a deleted project", plain text.

## Scope

In:
- One server resolver, `eventProjectsFor` (rooms/project-link.ts), returns a view per project id: open, trash (name only
  for someone who reads its folder by the rules), hidden, deleted. `eventOut` (rooms/store.ts) uses it for every project
  line kind, so the lines being added by the project-room work (`project_made`, `project_files_moved`) get it too.
- `RoomEventLine` project lines gain an optional `projectGone: { state: 'trash' | 'deleted', name? }`. `project` stays
  `{ id, name } | null` and is only set when the viewer can open it, so an older app never links a trashed project.
- Web: one helper `eventProjectOf(e)` (lib/rooms.ts) used by `eventText` and `EventLine`; the `project_room` line links
  its name too. New words in 6 languages.

Out:
- The conversation list, room headers and project room UI (session 4f's project-room work).
- Activity / notifications: checked, they already read the project at read time (project.joined, access.*, dev_env).
- The AI chat "Moved to Y" is a toast at the moment of the move, not a stored line: nothing to change.
- Named app links pasted in messages (link-names): already resolved per viewer on every ask.

## Steps

1. Resolver + schema + eventOut (server, shared).
2. Web helper, line text, link only when open; i18n en/ko/ja/zh/es/id.
3. Unit tests: server (renamed, trashed member, trashed outsider, no access, deleted), web (eventText for each).
4. e2e (mock API) at 1440 and 390; before/after screenshots.
5. changes/event-project-link.md.

## Decisions

None new. Follows "Event lines name the project only to a viewer who can open it" of
docs/decisions/20261119-channel-project-link.md, adding what the line says for a project in the trash or deleted.

## Risks

No migration. A trashed project's name goes only to someone whose folder rules give read on its folder (its people),
the same people who saw it before; an outsider cannot tell a trashed project from one they cannot open. "Deleted" is
told to everyone in the room: the line already said a project was linked, and a deleted project has nothing to reach.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit (rooms project link), web unit for lib/rooms, web e2e spec
for the line, tests/security rooms cases.

## Result

(filled in at the end)
