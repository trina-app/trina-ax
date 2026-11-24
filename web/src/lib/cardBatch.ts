// Cards of one kind from one answer, shown as one card (AskUserRequest.batch; docs/AGENTS/plan/20261123-0339-batch-
// cards.md). The owner, 2026-11-23: "스킬 여러개 만들라고 하니깐 한번에 저렇게 다 띄워 버리네". Server cards of the same
// answer with the same group key and the same choices (two buttons, or three as buttons) are one group; one press
// answers each of them. Anything else stays a card of its own.
import type { TurnRequest } from '@mycel/shared/api'

type Ask = Extract<TurnRequest, { kind: 'ask_user' }>
export interface CardLike { turnId: string; messageId: string; request: TurnRequest }

/** the choices a grouped card can show: yes / no, or three as buttons */
const groupable = (r: TurnRequest): r is Ask & { batch: NonNullable<Ask['batch']> } =>
  r.kind === 'ask_user' && r.origin === 'server' && !!r.batch && !r.multiple && !r.allowText &&
  ((r.options?.length ?? 0) === 2 || ((r.options?.length ?? 0) === 3 && !!r.buttons))

/** the group a card shows in (null: a card of its own); also the grouped card's React key, stable while items close */
export const groupKey = (c: CardLike): string | null => {
  const r = c.request
  if (!groupable(r)) return null
  // (the note says what Always allow covers: cards with another note never share one press)
  return JSON.stringify([c.messageId, r.batch.key, (r.options ?? []).map((o) => [o.value, o.label]), !!r.buttons, r.note ?? ''])
}

/** A kind whose cards arrive one call after another (saves: the engine runs them in order), so the first waits briefly
 * for the rest while its answer runs. Not a delete, share or post: those stand alone. */
export const gathers = (r: TurnRequest): boolean => groupable(r) && !('expiresAt' in r && r.expiresAt) && (r.batch.key.startsWith('skill:') || ['tool:write', 'tool:edit', 'tool:make_file'].includes(r.batch.key))

/** The cards in order, each group where its first card was. */
export function groupCards<T extends CardLike>(cards: readonly T[]): T[][] {
  const out: T[][] = []
  const at = new Map<string, T[]>()
  for (const c of cards) {
    const k = groupKey(c)
    const g = k ? at.get(k) : undefined
    if (g) { g.push(c); continue }
    const n = [c]
    out.push(n)
    if (k) at.set(k, n)
  }
  return out
}

/** A group (or one card) shown as the lean or grouped card: two or more, or one that leads in plain words. */
export const showsAsBatch = (g: readonly CardLike[]): boolean => g.length > 1 || (g.length === 1 && groupable(g[0]!.request) && !!g[0]!.request.batch.item)

/** how long a card that joined a group must be on screen before a press covers it */
export const CARD_JOIN_LOCK_MS = 1_500
/** the longest the buttons stay locked by cards that keep arriving; a press then covers only the cards seen long enough */
export const CARD_JOIN_LOCK_MAX_MS = 4_000

/**
 * The lock of a group's buttons. `at`: when each card now in the group came on screen (0: with the group itself). Locked
 * while the newest card is under CARD_JOIN_LOCK_MS old, for at most CARD_JOIN_LOCK_MAX_MS of arrivals in a row (a card
 * waiting inside a call has a time limit: it must stay answerable). `seen`: the cards a press may cover. `next`: when this
 * changes (null: it will not).
 */
export function joinLock(at: ReadonlyMap<string, number>, now: number): { locked: boolean; seen: Set<string>; next: number | null } {
  const seen = new Set<string>()
  const young: number[] = []
  for (const [id, t] of at) { if (now - t >= CARD_JOIN_LOCK_MS) seen.add(id); else young.push(t) }
  if (!young.length) return { locked: false, seen, next: null }
  const times = [...at.values()].filter((t) => t > 0).sort((a, b) => a - b)
  // where this run of arrivals began: each one under the lock's length after the one before
  let i = times.length - 1
  while (i > 0 && times[i]! - times[i - 1]! < CARD_JOIN_LOCK_MS) i--
  const until = times[i]! + CARD_JOIN_LOCK_MAX_MS
  const locked = now < until
  const ages = Math.min(...young) + CARD_JOIN_LOCK_MS
  return { locked, seen, next: locked ? Math.min(ages, until) : ages }
}

/**
 * The answers one press sends, in order: the unticked items their card's "no" (the last option) first, so an "Always
 * allow" that answers the rest of its kind (server chat/open-questions.ts alwaysAlso) never meets one meant as a no;
 * then the ticked ones the pressed value.
 */
export function pressPlan(cards: readonly CardLike[], value: string, ticked: ReadonlySet<string>, alone = cards.length === 1): { requestId: string; answer: string }[] {
  // one card alone has no tick: it is the one pressed (`alone`: of the whole group, when `cards` is only the part seen)
  const on = (c: CardLike) => alone || ticked.has(c.request.requestId)
  const no = cards.filter((c) => !on(c))
  const yes = cards.filter(on)
  const lastOf = (c: CardLike) => (c.request.kind === 'ask_user' ? c.request.options?.at(-1)?.value ?? null : null)
  const noValue = cards[0] ? lastOf(cards[0]) : null
  // pressing the card's own "no": every item gets it
  if (value === noValue) return cards.map((c) => ({ requestId: c.request.requestId, answer: value }))
  return [
    ...no.flatMap((c) => { const v = lastOf(c); return v ? [{ requestId: c.request.requestId, answer: v }] : [] }),
    ...yes.map((c) => ({ requestId: c.request.requestId, answer: value })),
  ]
}
