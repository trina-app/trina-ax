// The widening list (docs/DECISIONS.md "People who see a shared chat later: nothing new is hidden", the owner on
// 2026-11-14; plan docs/AGENTS/plan/20261114-shared-chats-everywhere.md "The widening list"): when someone adds people to
// a team project (its Members dialog), the answers of its shared chats that the new people would start seeing although
// they used places some of them can't open. Not just a count: each item says which chat, who asked, when, a line of the
// answer and the places it used, each place by name only when the adder may open it now.
//
// What is listed: an answer the adder sees themselves (chat/shared-answers.ts, rule b applied for them) whose recorded
// places (shared_answer_reads) some new person can't open under the rules after the save, and that is not hidden from
// that person anyway (an older answer no card covered keeps hiding from them: it widens nothing). The adder never learns
// more than they already see: answers hidden from them are left out, places they can't open are "a place you can't
// open", and "missed by" names only the people and groups they picked.
//
// One pass, the count and the page together, within the owner's budget (300 ms for 10,000 answers in 50 chats:
// tests/unit/b-widening-answers-bench.test.ts): three queries (the folders' paths, the project's shared chats' messages
// with their records, the shown answers' text, titles and askers), each distinct place checked once for the new people
// and once for the adder, never once per answer. For each new person an older answer is judged by its own record only
// (not by the answers above it): an answer built on one hidden from them may be listed although it stays hidden from
// them too (the list warns of more, never of less).
import type { Database } from 'bun:sqlite'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { nameSegs, sourceKey, viewersOf, roomName, slackPlaceName, type ReadSource } from './read-scope'
import { groupsHide, hiddenAnswersCutover, nodeOf, withheldAmong, type Node, type NodeRow, type ViewerJudge } from './shared-answers'
import { getRow } from '../integrations/connections/store'
import { shareRow } from '../integrations/google-drive/shares'

/** Past this many answers the count stops (`totalCapped`, "50,000+"). */
export const WIDENING_COUNT_CAP = 50_000
export const WIDENING_PAGE = 20
export const WIDENING_PAGE_MAX = 50
const PREVIEW_MAX = 120

/** A person or group the adder picked, with the new people it brings (ids). */
export interface WideningSubject { key: string; name: string; people: readonly string[] }
/** One listed answer. `places`: by name when the adder may open it now, else hidden (several hidden: one). */
export interface WideningItem {
  chatId: string; chatTitle: string; messageId: string; at: string
  askedBy: { id: string; name: string; avatarVersion?: number } | null
  preview: string
  places: ({ name: string } | { hidden: true })[]
  missedBy: string[]
}
export interface WideningResult { total: number; totalCapped: boolean; items: WideningItem[]; nextRowid: number | null }
/** Counted for the bench and its limits: rule checks, by place and person set. */
export interface WideningStats { checks: number }
/** Words for the places that have no name of their own (the caller's locale). */
export interface PlaceWords { root: string; mine: string; room: string }

/** The first line of an answer as plain text, at most PREVIEW_MAX characters. */
export function answerPreview(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l && !/^```/.test(l) && !/^[-*_=]{3,}$/.test(l)) ?? ''
  const plain = line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*)[*_](?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > PREVIEW_MAX ? `${plain.slice(0, PREVIEW_MAX - 1)}…` : plain
}

/**
 * The answers of a team project's shared chats that `newPeople` would start seeing although some of them can't open a
 * place the answer used, newest first: the count (`total`, capped) and one page (`limit` items with a message rowid below
 * `before`; 0: the count alone). `rules.now`: the folder rules now (the adder's verdicts); `rules.after`: after the save
 * (the new people's). `subjects`: who the adder picked (for `missedBy`). The caller has checked that `viewer` may change
 * the project's members and sees its chats.
 */
export function wideningAnswers(db: Database, rules: { now: RuleSet; after: RuleSet }, target: { kind: 'project'; projectId: string }, newPeople: readonly Principal[], viewer: Principal,
  page: { before?: number | null; limit: number }, o: { subjects?: readonly WideningSubject[]; stats?: WideningStats; words?: PlaceWords } = {}): WideningResult {
  const empty: WideningResult = { total: 0, totalCapped: false, items: [], nextRowid: null }
  if (!newPeople.length) return empty
  const stats = o.stats ?? { checks: 0 }
  // 1. every folder's path, once (the rule checks of folder places need no query each)
  const paths = new Map((db.query('SELECT id, path FROM folders').all() as { id: string; path: string }[]).map((r) => [r.id, r.path]))
  const readersAmong = (s: ReadSource, people: Principal[], set: RuleSet): Set<string> => {
    stats.checks++
    if (s.type === 'folder' || s.type === 'root') {
      const p = s.type === 'root' ? '' : paths.get(s.id)
      if (p === undefined) return new Set()
      const segs = p === '' ? [] : p.split('/')
      return new Set(people.filter((x) => atLeast(set.access(x, segs), 'read')).map((x) => x.id))
    }
    if (s.type === 'name') { const segs = nameSegs(s.path); return new Set(people.filter((x) => set.canList(x, segs)).map((x) => x.id)) }
    if (s.type === 'user') return new Set(people.some((x) => x.id === s.id) ? [s.id] : [])
    if (s.type === 'slack') return new Set(people.some((x) => x.id === s.userId) ? [s.userId] : [])
    return viewersOf(db, set, s, people)
  }
  // the new people's readers of each place (rules after the save), once per place
  const people = [...newPeople]
  const newReaders = new Map<string, Set<string>>()
  const newOf = (s: ReadSource) => {
    const k = sourceKey(s)
    let v = newReaders.get(k)
    if (!v) { try { v = readersAmong(s, people, rules.after) } catch { v = new Set() } newReaders.set(k, v) }
    return v
  }
  // the adder's own verdict of each place (rules now), once per place: their walk and the names they may see
  const judge: ViewerJudge = { me: viewer, verdicts: new Map(), check: (s) => readersAmong(s, [viewer], rules.now).has(viewer.id) }
  const viewerReads = (s: ReadSource): boolean => {
    const k = sourceKey(s)
    let ok = judge.verdicts.get(k)
    if (ok === undefined) { try { ok = judge.check!(s) } catch { ok = false } judge.verdicts.set(k, ok) }
    return ok
  }

  // 2. the project's shared chats' messages with their turns' person and records, in order (rowid)
  const rows = db.query(`SELECT m.rowid AS rid, m.id, m.chat_id, m.parent_id, m.role, t.user_id AS runner, r.reads, r.left_out, m.created_at
    FROM chats c JOIN messages m ON m.chat_id = c.id LEFT JOIN turns t ON t.id = m.turn_id LEFT JOIN shared_answer_reads r ON r.message_id = m.id
    WHERE c.project_id = ? AND c.shared_at IS NOT NULL AND c.deleted_at IS NULL ORDER BY m.rowid`).all(target.projectId) as (NodeRow & { rid: number; chat_id: string })[]
  const cutover = hiddenAnswersCutover(db)
  const byChat = new Map<string, Node[]>()
  const meta = new Map<string, { rid: number; chat: string }>()
  for (const r of rows) {
    const n = nodeOf(r, cutover)
    let list = byChat.get(r.chat_id)
    if (!list) byChat.set(r.chat_id, (list = []))
    list.push(n)
    if (n.answer) meta.set(n.id, { rid: r.rid, chat: r.chat_id })
  }
  // the answers hidden from the adder, chat by chat (their walk: rule b with what is above), one rule check per place
  const hiddenFromViewer = new Set<string>()
  for (const nodes of byChat.values()) for (const id of withheldAmong(db, rules.now, nodes, viewer.id, judge)) hiddenFromViewer.add(id)

  const subjects = o.subjects ?? []
  const listed: { node: Node; rid: number; chat: string; widens: Set<string> }[] = []
  let total = 0, walked = 0, capped = false
  const answers = [...meta.keys()]
  const nodeById = new Map<string, Node>()
  for (const nodes of byChat.values()) for (const n of nodes) if (n.answer) nodeById.set(n.id, n)
  // newest first
  answers.sort((a, b) => meta.get(b)!.rid - meta.get(a)!.rid)
  const limit = Math.max(0, page.limit)
  let more = false
  for (const id of answers) {
    if (++walked > WIDENING_COUNT_CAP) { capped = true; break }
    const n = nodeById.get(id)!
    if (!n.rec || hiddenFromViewer.has(id)) continue
    const groups = n.rec.reads
    if (!groups.length) continue
    // who among the new people would start seeing it although they miss one of its places
    const widens = new Set<string>()
    for (const p of people) {
      if (n.runner === p.id) continue
      const misses = groups.some((g) => !g.c.has(p.id) && g.s.some((s) => !newOf(s).has(p.id)))
      if (!misses) continue
      // an older answer no card covered stays hidden from them: it widens nothing (rule b, its own record)
      if (!n.late && groupsHide(groups, p.id, (s) => newOf(s).has(p.id))) continue
      widens.add(p.id)
    }
    if (!widens.size) continue
    total++
    const m = meta.get(id)!
    if (page.before != null && m.rid >= page.before) continue
    if (listed.length < limit) listed.push({ node: n, rid: m.rid, chat: m.chat, widens })
    else if (limit > 0) more = true
  }
  if (!listed.length) return { total, totalCapped: capped, items: [], nextRowid: null }

  // 3. the shown answers' text, chat titles and askers, by primary key
  const shown = db.query(`SELECT m.id, m.content, m.created_at, c.title, u.id AS uid, u.name, u.avatar_version FROM messages m JOIN chats c ON c.id = m.chat_id
    LEFT JOIN turns t ON t.id = m.turn_id LEFT JOIN users u ON u.id = t.user_id WHERE m.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(listed.map((x) => x.node.id))) as { id: string; content: string; created_at: string; title: string | null; uid: string | null; name: string | null; avatar_version: number | null }[]
  const byId = new Map(shown.map((r) => [r.id, r]))
  const words = o.words ?? { root: 'the top of the team folder', mine: 'your personal folder', room: "room '{name}'" }
  const placeName = (s: ReadSource): string => {
    switch (s.type) {
      case 'root': return words.root
      case 'folder': { const p = paths.get(s.id); return p ? `${p}/` : words.root }
      case 'name': return nameSegs(s.path).join('/') || words.root
      case 'user': return words.mine
      case 'integration': return getRow(db, s.id)?.name ?? '?'
      case 'drive_share': return shareRow(db, s.id)?.name ?? 'Google Drive'
      case 'room': return words.room.replace('{name}', roomName(db, s.id))
      case 'slack': return slackPlaceName(s)
    }
  }
  const items: WideningItem[] = []
  for (const x of listed) {
    const r = byId.get(x.node.id)
    if (!r) continue
    // the places it used that some new person misses: by name where the adder may open them, else one "hidden"
    const seen = new Set<string>()
    const places: WideningItem['places'] = []
    let hidden = false
    for (const g of x.node.rec!.reads) for (const s of g.s) {
      const k = sourceKey(s)
      if (seen.has(k)) continue
      seen.add(k)
      if (![...x.widens].some((id) => !g.c.has(id) && !newOf(s).has(id))) continue
      if (viewerReads(s)) places.push({ name: placeName(s) })
      else hidden = true
    }
    if (hidden) places.push({ hidden: true })
    const missedBy = subjects.filter((sub) => sub.people.some((id) => x.widens.has(id))).map((sub) => sub.name)
    items.push({
      chatId: x.chat, chatTitle: r.title ?? '', messageId: x.node.id, at: r.created_at,
      askedBy: r.uid ? { id: r.uid, name: r.name ?? '', ...(r.avatar_version ? { avatarVersion: r.avatar_version } : {}) } : null,
      preview: answerPreview(r.content), places, missedBy,
    })
  }
  return { total, totalCapped: capped, items, nextRowid: more ? listed[listed.length - 1]!.rid : null }
}
