// Reordering a short list by hand: dragging a row, or Move up / Move down (pages/admin/Credentials.tsx, the team's AI
// accounts). The list is saved as priorities 10, 20, 30 … in the new order, so the server's order (priority first)
// matches the screen; only the rows whose number changes are sent.

/** The list with the item at `from` taken out and put back at `to` (both clamped to the list). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length) return next
  const at = Math.max(0, Math.min(next.length - 1, to))
  const [item] = next.splice(from, 1)
  next.splice(at, 0, item!)
  return next
}

/** The priority each row needs so the list is used in this order (10, 20, 30 …), only for rows that differ now. */
export function priorityPatches<T extends { id: string; priority: number }>(list: readonly T[]): { id: string; priority: number }[] {
  return list.flatMap((x, n) => (x.priority === (n + 1) * 10 ? [] : [{ id: x.id, priority: (n + 1) * 10 }]))
}

/** Where a row dragged to `y` (the pointer's height on the screen) lands, given the middle height of each row as laid
 * out before the drag: the number of other rows whose middle is above the pointer. */
export function dropIndex(mids: readonly number[], from: number, y: number): number {
  let n = 0
  for (const [i, m] of mids.entries()) if (i !== from && y > m) n++
  return n
}
