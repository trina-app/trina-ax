# The AI account order is changed by dragging, with no library and no new endpoint

- Date: 2026-11-18
- Status: accepted
- Supersedes: none
- Branch: feat/ai-accounts-drag-order (the product owner, QA TC-4836)

- **Ask:** in Admin › AI providers the accounts under a provider are a priority list; the owner wants to grab a row and
  drag it instead of using Move up / Move down in each row's ⋯ menu.
- **Rule:** the owner and admins (the people who see the ⋯ menu) get a drag handle on each team account row when the
  provider has two or more accounts. Mouse and touch use pointer events on the handle (pointer capture,
  `touch-action: none` on the handle only, so the rest of the row still scrolls the page). The keyboard uses the same
  handle: Space or Enter picks the row up, the arrow keys move it, Space or Enter drops it, Escape or leaving the handle
  puts it back. Each step is said in the page's polite live region (`useAnnounce`). The drop saves through the same
  call Move up / Move down use, `PATCH /api/admin/credentials/:id` with `priority`, renumbered 10, 20, 30 … in the new
  order and sent only for the rows whose number changes (`web/src/lib/reorder.ts`). The list shows the new order at
  once and is read again after the calls. Move up / Move down stay.
- **Why no library:** the repo had no drag-and-drop library and no sortable list. One short vertical list needs a
  pointer-down, a pointer-move and a pointer-up; a library (dnd-kit and the like) would add a dependency and bundle size
  for that, and the keyboard and announcements are a few lines with our own words in six languages.
- **Why no new endpoint:** the per-row PATCH is the call admins already make for Move up / Move down, its permission
  checks stay as they are, and a provider has a handful of accounts. If a save fails halfway, the reload shows what was
  saved, as with Move up / Move down.
- **Hint:** "How order works" (a link that opened the tier rule and the cost note) is replaced by one plain line under a
  list of two or more: "{product} uses the top working account. If one is refused or at its limit, it moves to the
  next." A second sentence about accounts given to a person or a group shows only when the list has such an account.
  The cost note moved into an API key's details, next to its cost.
- **Phone:** with the handle, the row leaves out the provider's mark at phone width (every account under a provider has
  the same mark), so the name keeps its room.
- Version impact: patch.
