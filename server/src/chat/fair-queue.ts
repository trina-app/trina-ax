/** User FIFO; least occupied user first; a durable round-robin ticket breaks ties. */
export interface QueueTiming { queueSeq?: number; dispatchedAt?: string; wallDeadlineAt?: string }
export interface FairEntry { turnId: string; chatId: string; userId: string; queueSeq: number }

export function selectFairHead<T extends FairEntry>(queue: readonly T[], active: ReadonlyMap<string, number>, tickets: ReadonlyMap<string, number>, busy: ReadonlySet<string> = new Set()): T | null {
  const heads = new Map<string, T>()
  for (const item of queue) if (!heads.has(item.userId) || item.queueSeq < heads.get(item.userId)!.queueSeq) heads.set(item.userId, item)
  let best: T | null = null
  for (const item of heads.values()) {
    if (busy.has(item.chatId)) continue
    const running = active.get(item.userId) ?? 0, ticket = tickets.get(item.userId) ?? Number.MAX_SAFE_INTEGER
    const priorRunning = best ? active.get(best.userId) ?? 0 : Infinity
    const priorTicket = best ? tickets.get(best.userId) ?? Number.MAX_SAFE_INTEGER : Infinity
    if (!best || running < priorRunning || running === priorRunning && (ticket < priorTicket || ticket === priorTicket && item.userId < best.userId)) best = item
  }
  return best
}

/** Advisory rank: virtual dispatch without completions or a concurrency cap, never mutating live state. */
export function fairOrder<T extends FairEntry>(queue: readonly T[], active: ReadonlyMap<string, number>, tickets: ReadonlyMap<string, number>, busy: ReadonlySet<string> = new Set()): T[] {
  const left = [...queue], counts = new Map(active), rr = new Map(tickets), result: T[] = []
  let next = Math.max(0, ...rr.values())
  while (left.length) {
    const head = selectFairHead(left, counts, rr, busy)
    if (!head) { result.push(...left.sort((a, b) => a.queueSeq - b.queueSeq)); break }
    result.push(head); left.splice(left.indexOf(head), 1)
    counts.set(head.userId, (counts.get(head.userId) ?? 0) + 1); rr.set(head.userId, ++next)
  }
  return result
}
