# The free-roam demo's AI tools are an allow-list

- Date: 2026-11-23
- Status: accepted
- Supersedes: the "everything else of the registry is offered" rule of
  [20261119-demo-free-roam-a.md](20261119-demo-free-roam-a.md); its table of refused tools stands
- Branch: fix/demo-tool-allowlist (an audit of dev for the public demo)

- **Ask:** the audit found no tool open to visitors today, but a tool added later would be open until someone listed it.
- **Rule:** a free-roam turn offers only `FREE_ROAM_TOOLS` (server/src/demo/guard.ts) and a connected service's tools (the
  integrations provider, which is how the demo's fake Gmail and Higgsfield reach the AI). `FREE_ROAM_REFUSED_TOOLS` and the
  browser pane tools win over both. A test fails while a registered tool is in neither list.
- **Also:** `generate_video` (real credits) and `save_work_file` (the dev environment) are refused by name. A free-roam
  demo renders no promo video on any route: `shareAnswerToRoom` started one past the tool fence.
- **Fakes required:** a free-roam demo file without `fakes` is refused at start (`readDemoFile`), because the connected
  services' tools are open there only because they are the fakes. `promo_video_versions` is refused with the other promo
  video tools.
- **Why this shape:** closed by default costs one line per new demo tool; open by default costs a public incident.
- **Version impact:** patch.
