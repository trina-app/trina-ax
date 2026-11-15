// The world of the widening list's budget (docs/AGENTS/plan/20261114-shared-chats-everywhere.md "Performance budget"):
// a team of 50 people in 6 groups, a team project with 50 shared chats and `answers` answers whose records use 40
// distinct places (a mix of groups a card's yes covered, silent ones and x ones, before and after the cutover), and a
// group of 8 who are being added. Used by tests/unit/b-widening-answers-bench.test.ts (10,000 answers) and
// scripts/bench/widening-answers.ts (10x, by hand).
import type { Database } from 'bun:sqlite'
import { loadPrincipal, type Principal } from '../../server/src/policy/access'
import { setHiddenAnswersCutover, type ReadGroup } from '../../server/src/chat/shared-answers'
import type { ReadSource } from '../../server/src/chat/read-scope'

export interface WideningWorld { projectId: string; viewer: Principal; adding: Principal[]; places: ReadSource[] }

const pad = (n: number, w = 3) => String(n).padStart(w, '0')
let worlds = 0

/** Build it in `db` (a migrated database with the harness's people); `owner`: who makes the project and looks. */
export function buildWideningWorld(db: Database, o: { answers: number; chats?: number; owner: string }): WideningWorld {
  const w = ++worlds
  const chats = o.chats ?? 50
  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()
  const people = Array.from({ length: 50 }, (_, i) => `bw${w}-${pad(i)}`)
  const groups = Array.from({ length: 6 }, (_, i) => `bw${w}-group-${i}`)
  const projectId = crypto.randomUUID()
  const places: ReadSource[] = []
  db.transaction(() => {
    const addUser = db.query("INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, 'member')")
    for (const [i, u] of people.entries()) addUser.run(u, u, `Person ${w}-${i}`)
    const addGroup = db.query('INSERT INTO groups (id, name) VALUES (?, ?)')
    const member = db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)')
    for (const [i, g] of groups.entries()) {
      addGroup.run(g, `Bench group ${w}-${i}`)
      // groups 0-4: 8 people each; group 5 (the one being added): 8 others, none of them in the project
      for (let k = 0; k < 8; k++) member.run(g, people[i * 8 + k]!)
    }
    member.run(groups[0]!, o.owner)
    // 40 places: folders each read by one or two groups (the owner's group among them for half)
    const addFolder = db.query('INSERT INTO folders (id, path, created_at) VALUES (?, ?, ?)')
    const addRule = db.query("INSERT OR IGNORE INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'group', ?, 'read')")
    for (let i = 0; i < 40; i++) {
      const id = `bw${w}-f-${pad(i)}`
      addFolder.run(id, `groups/bench-${w}/area-${pad(i)}`, iso(now))
      addRule.run(`${id}-r1`, id, groups[i % 5]!)
      if (i % 2 === 0) addRule.run(`${id}-r0`, id, groups[0]!)
      if (i % 4 === 0) addRule.run(`${id}-r5`, id, groups[5]!)
      places.push({ type: 'folder', id })
    }
    db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(projectId, `Bench ${w}`, `projects/bench-${w}`, o.owner, iso(now))
    const chatIds = Array.from({ length: chats }, () => crypto.randomUUID())
    const addChat = db.query('INSERT INTO chats (id, user_id, project_id, shared_at, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const [i, c] of chatIds.entries()) addChat.run(c, o.owner, projectId, iso(now), `Bench chat ${i}`, iso(now), iso(now))
    const addMsg = db.query("INSERT INTO messages (id, chat_id, parent_id, role, author_id, content, status, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?)")
    const addTurn = db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id) VALUES (?, ?, ?, 'claude-code', 'done', ?)")
    const addRec = db.query('INSERT INTO shared_answer_reads (message_id, chat_id, reads) VALUES (?, ?, ?)')
    const last = new Map<string, string>()
    // the first 40% before the cutover
    const start = now - o.answers * 60_000
    const askers = [o.owner, ...people.slice(0, 7)]
    for (let i = 0; i < o.answers; i++) {
      const c = chatIds[i % chats]!
      const at = iso(start + i * 60_000)
      const q = crypto.randomUUID(), a = crypto.randomUUID(), t = crypto.randomUUID()
      const asker = askers[i % askers.length]!
      addMsg.run(q, c, last.get(c) ?? null, 'user', asker, `question ${i}`, null, at)
      addTurn.run(t, c, asker, a)
      addMsg.run(a, c, q, 'assistant', null, `Answer ${i}: the figures for area ${i % 40}`, t, at)
      last.set(c, a)
      const s1 = places[i % 40]!, s2 = places[(i * 7 + 3) % 40]!
      const audience = [o.owner, ...people.slice(0, 8)]
      const kind = i % 5
      const reads: ReadGroup[] = kind === 0 ? [{ c: audience, s: [s1], y: 1 }] : kind === 1 ? [{ c: audience, s: [s1, s2] }]
        : kind === 2 ? [{ c: audience, s: [s2], x: 1 }] : [{ c: audience, s: [s1] }, { c: audience, s: [s2], y: 1 }]
      addRec.run(a, c, JSON.stringify(reads))
    }
    setHiddenAnswersCutover(db, iso(start + Math.floor(o.answers * 0.4) * 60_000))
  })()
  const viewer = loadPrincipal(db, o.owner)!
  const adding = people.slice(40, 48).map((id) => loadPrincipal(db, id)!)
  return { projectId, viewer, adding, places }
}

/** `db` with every query and prepare counted (the bench's "at most 3 queries"). */
export function countingDb(db: Database): { db: Database; count: () => number; reset: () => void } {
  let n = 0
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'query' || prop === 'prepare') return (...args: unknown[]) => { n++; return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string]!(...args) }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  return { db: proxy, count: () => n, reset: () => { n = 0 } }
}
