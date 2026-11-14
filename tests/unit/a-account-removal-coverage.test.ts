// Every column that points at users(id) is either removed with a deleted account (by removeAccount itself or by an
// area's cleanup hook, server/src/auth/account-removal.ts) or named in KEPT_WITH_ACCOUNT with the reason it stays. A
// new table with a user column fails here until someone decides. The hooks also run once at start for accounts deleted
// earlier (cleanUpDeletedAccounts), and twice is the same as once.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { accountCleanups, cleanUpDeletedAccounts, KEPT_WITH_ACCOUNT, REMOVED_BY_REMOVE_ACCOUNT, runAccountCleanups } from '../../server/src/auth/account-removal'

let h: Harness, owner: Client
beforeAll(async () => {
  h = await harness('account-removal-coverage')
  owner = await withOwner(h)
})
afterAll(async () => { await h?.close() })

function userColumns(): string[] {
  const out: string[] = []
  for (const { name } of h.ctx.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    for (const fk of h.ctx.db.query(`PRAGMA foreign_key_list("${name}")`).all() as { table: string; from: string }[]) {
      if (fk.table === 'users') out.push(`${name}.${fk.from}`)
    }
  }
  return out.sort()
}

describe('coverage', () => {
  test('the hooks of every area are registered (accounts, chat, connections)', () => {
    expect(accountCleanups(h.ctx).map((c) => c.name).sort()).toEqual(['accounts', 'chat', 'connections'])
  })

  test('every user column is removed or kept on purpose, and only one of the two', () => {
    const hooked = accountCleanups(h.ctx).flatMap((c) => [...c.rows, ...(c.covers ?? [])])
    const removed = new Set([...REMOVED_BY_REMOVE_ACCOUNT, ...hooked])
    const kept = new Set(Object.keys(KEPT_WITH_ACCOUNT))
    const missing = userColumns().filter((c) => !removed.has(c) && !kept.has(c))
    expect(missing, 'add each to a cleanup hook (auth/account-removal.ts) or to KEPT_WITH_ACCOUNT with the reason').toEqual([])
    expect([...removed].filter((c) => kept.has(c))).toEqual([])
    // every name listed is a real column (a typo would hide a leak)
    const cols = new Set(userColumns())
    for (const c of hooked) {
      const [t, col] = c.split('.') as [string, string]
      const names = (h.ctx.db.query(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((x) => x.name)
      expect(names, c).toContain(col)
    }
    for (const c of kept) expect(cols.has(c), c).toBe(true)
    for (const c of REMOVED_BY_REMOVE_ACCOUNT) expect(cols.has(c), c).toBe(true)
  })
})

describe('accounts deleted before this build', () => {
  test('the start-up pass removes what the hooks remove now, and running it again changes nothing', async () => {
    const m = await addMember(h, owner, { username: 'old' })
    const at = new Date().toISOString()
    h.ctx.db.query('INSERT INTO suggestion_dismissals (user_id, key, dismissed_at) VALUES (?, ?, ?)').run(m.id, 'k', at)
    h.ctx.db.query('INSERT INTO login_nets (user_id, net, last_at) VALUES (?, ?, ?)').run(m.id, '10.0.0.0/24', Date.now())
    // deleted the old way: only the tombstone, the rows above left behind
    h.ctx.db.query("UPDATE users SET status = 'disabled', deleted_at = ? WHERE id = ?").run(at, m.id)
    expect(await cleanUpDeletedAccounts(h.ctx)).toBeGreaterThan(0)
    for (const t of ['suggestion_dismissals', 'login_nets', 'sessions']) expect(h.ctx.db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(m.id), t).toEqual({ n: 0 })
    expect(await runAccountCleanups(h.ctx, m.id)).toBe(0)
    // a live account is never touched by the start-up pass
    const live = await addMember(h, owner, { username: 'live' })
    h.ctx.db.query('INSERT INTO suggestion_dismissals (user_id, key, dismissed_at) VALUES (?, ?, ?)').run(live.id, 'k', at)
    await cleanUpDeletedAccounts(h.ctx)
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM suggestion_dismissals WHERE user_id = ?').get(live.id)).toEqual({ n: 1 })
  })
})
