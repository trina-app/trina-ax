# A project is renamed where people look for it: its name, its row's menu, the phone bar

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/project-rename-in-place (the owner: "renaming a project is hard to find, on phone and desktop")

- **Ask:** Rename lived only in the name's menu at the top of a project's page ("Projects / name ▾"), and for a member
  that menu says Edit, not Rename. People look for it on the big name and in the list, as in Notion, Drive, a Slack
  channel or a ChatGPT/Claude project.
- **Rule:** whoever manages the project (`Project.canManage`: the owner and admins for a team project, its creator
  while they may edit it) renames it
  - by a click on the page's big name (`components/EditableTitle.tsx`): it turns into a field with the name selected;
    Enter or leaving the field saves, Esc puts it back. On a computer the name shows a faint fill, a text cursor and
    the tip "Rename" under the pointer; no new button;
  - from the "···" of its row in the Projects list beside the rail and on the phone's Projects tab (also a right-click,
    and a long press on a touch screen). The row menu has the Projects page cards' items by the same rules
    (`components/projectActions.tsx useProjectMenuItems`): Rename, Members, Copy link, Leave, Delete;
  - on a phone, by a tap on the project's name in the top bar (the same prompt as the menu's Rename).
  The name's menu at the top stays as it was. Anyone else (a member who does not manage it, a guest) reads plain
  text, and has no Rename in the row's menu. Not in the trash (its page has no name menu there either). Every way is
  the one name-only call (`PATCH /api/projects/:id` with `name`) and its optimistic queue, so a rename shows at once
  wherever the project is named, also on its open page when it was renamed from the list.
- **Left out:** a pencil or Rename button beside the name (the owner wants no more buttons); renaming in place on the
  phone (a 48 px bar is too small for a field: the prompt opens).
- Tests: e2e `project-rename.spec.ts` (title click, list row menu, phone bar, a member without the right).
- Version impact: **minor** (a new way to do something people do).
