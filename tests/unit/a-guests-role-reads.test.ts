// Every SQL in server/src that reads users.role without the guest column is reviewed (docs/DECISIONS.md "Guests: only
// what they were invited to"). A guest is stored as role 'member' with users.guest = 1 (the role column's CHECK cannot
// be widened without rebuilding users), so a raw read of `role` sees a guest as a member. The scanner
// (guest-role-reads-scan.ts) finds string and template literals, multi-line ones included, that touch the users table and
// still name `role` / `u.role` once the guest-aware CASE is taken out, and every USER_COLS splice after a table alias.
// Each hit must be in guest-role-reads.reviewed.json with the reason it is safe; a new hit, or a listed one that is gone,
// fails here.
import { expect, test } from 'bun:test'
import reviewed from './guest-role-reads.reviewed.json'
import { scanRoleReads } from './guest-role-reads-scan'

const key = (r: { file: string; sql: string }) => `${r.file}\u0000${r.sql}`

test('every raw read of users.role is reviewed, and the list has no stale entry', () => {
  const found = scanRoleReads()
  const listed = new Map((reviewed as { file: string; sql: string; reason: string }[]).map((r) => [key(r), r]))
  const unreviewed = found.filter((r) => !listed.has(key(r)))
  expect(unreviewed).toEqual([])
  const now = new Set(found.map(key))
  const stale = [...listed.values()].filter((r) => !now.has(key(r))).map((r) => `${r.file}: ${r.sql.slice(0, 80)}`)
  expect(stale).toEqual([])
  for (const r of listed.values()) expect(r.reason.length).toBeGreaterThan(10)
})

test('a raw read that is not an owner/admin filter has its own reason (never the generic one)', () => {
  const generic = "filter on owner/admin only: a guest is stored as role 'member' (users.guest = 1) and never matches"
  for (const r of reviewed as { file: string; sql: string; reason: string }[]) {
    if (r.reason !== generic) continue
    // what is left once the owner/admin filters are taken out names no role
    const rest = r.sql
      .replace(/CASE WHEN (\w+\.)?guest = 1 THEN 'guest' ELSE (\w+\.)?role END( AS role)?/g, '')
      .replace(/(\w+\.)?role ?= ?'(owner|admin)'/g, '')
      .replace(/(\w+\.)?role ?IN ?\('owner', ?'admin'\)/g, '')
    expect(`${r.file}: ${/\b(\w+\.)?role\b/.test(rest) ? rest : 'ok'}`).toBe(`${r.file}: ok`)
  }
})

test('the scanner catches a multi-line read, u.role and a USER_COLS splice', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = path.join(import.meta.dir, '..', '..', 'server', 'src', '__guest_scan_probe__')
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'probe.ts')
  try {
    fs.writeFileSync(f, [
      "const re = /it's/ // a regex with a quote is not a string",
      'const a = `SELECT id,',
      '  role',
      '  FROM users WHERE id = ?`',
      "const b = 'SELECT u.id, u.role FROM chats c JOIN users u ON u.id = c.user_id'",
      'const c = `SELECT s.id, u.${USER_COLS.split(", ").join(", u.")} FROM sessions s JOIN users u ON u.id = s.user_id`',
      "const d = \"SELECT id, CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role FROM users\"",
    ].join('\n'))
    const hits = scanRoleReads().filter((r) => r.file.startsWith('__guest_scan_probe__/'))
    expect(hits.map((h) => h.sql.slice(0, 30))).toEqual(['SELECT id, role FROM users WHE', 'SELECT u.id, u.role FROM chats', 'USER_COLS splice: SELECT s.id,'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
