// Finds SQL in server/src that reads users.role (docs/DECISIONS.md "Guests: only what they were invited to"): a guest
// is stored as role 'member' with users.guest = 1, so SQL that reads `role` from users without the guest column sees
// a guest as a member. Used by tests/unit/a-guests-role-reads.test.ts against the reviewed list next to it.
import fs from 'node:fs'
import path from 'node:path'

export interface RoleRead { file: string; sql: string }

const ROOT = path.join(import.meta.dir, '..', '..', 'server', 'src')

function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
}

/** every string or template literal (multi-line included) of a file */
function literals(src: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; continue }
    // a regex literal (a '/' where an expression starts): skipped, so its quotes are not taken for strings
    if (c === '/') {
      let k = i - 1
      while (k >= 0 && /\s/.test(src[k]!)) k--
      const prev = k >= 0 ? src[k]! : ''
      const word = /[\w$]/.test(prev) ? (src.slice(0, k + 1).match(/[\w$]+$/)?.[0] ?? '') : ''
      if (!prev || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || word === 'return' || word === 'typeof' || word === 'case') {
        let j = i + 1, inClass = false
        while (j < src.length && src[j] !== '\n') {
          const d = src[j]!
          if (d === '\\') { j += 2; continue }
          if (d === '[') inClass = true
          else if (d === ']') inClass = false
          else if (d === '/' && !inClass) break
          j++
        }
        if (src[j] === '/') { i = j + 1; continue }
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1, buf = ''
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue } buf += src[j]; j++ }
      out.push(buf)
      i = j + 1
      continue
    }
    i++
  }
  return out
}

const norm = (s: string) => s.replace(/\$\{[^}]*\}/g, '${}').replace(/\s+/g, ' ').trim()

export function scanRoleReads(): RoleRead[] {
  const files: string[] = []
  walk(ROOT, files)
  const out: RoleRead[] = []
  for (const f of files.sort()) {
    const src = fs.readFileSync(f, 'utf8')
    const rel = path.relative(ROOT, f).split(path.sep).join('/')
    for (const lit of literals(src)) {
      // USER_COLS spliced after a table alias ("u.${USER_COLS}", USER_COLS.split(...)): its CASE would break, and an
      // aliased copy of the plain column list would read the stored role
      if (/[\w]\.\$\{\s*USER_COLS\b|USER_COLS\s*\.\s*split/.test(lit)) { out.push({ file: rel, sql: `USER_COLS splice: ${norm(lit).slice(0, 200)}` }); continue }
      const n = norm(lit)
      const touchesUsers = /\b(FROM|JOIN)\s+users\b/i.test(n) || /\bu\.role\b/.test(n)
      if (!touchesUsers) continue
      // a role read: `role` / `u.role` as a column, or the USER_COLS splice (`${}` after SELECT with a users table)
      // the guest-aware read (auth/guests.ts roleSql, USER_COLS) is fine: what is left must not name the role
      const rest = n.replace(/CASE WHEN (\w+\.)?guest = 1 THEN 'guest' ELSE (\w+\.)?role END( AS role)?/g, 'GUESTROLE')
      if (!/\b(\w+\.)?role\b/i.test(rest)) continue
      out.push({ file: rel, sql: n.slice(0, 600) })
    }
  }
  return out
}

if (import.meta.main) for (const r of scanRoleReads()) console.log(`${r.file}\t${r.sql}`)
