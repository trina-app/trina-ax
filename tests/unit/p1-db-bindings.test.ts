// Named SQL parameters on the server's database. openDb opens it with `strict: true`; there Bun 1.3.12 (the runtime the
// server ships with, versions.json) takes only keys without the prefix (`{ from }` for `$from` in the SQL) and throws
// `Missing parameter "from"` on a `$from` key, while Bun 1.4 takes both. A run on a 1.4 Mac did not see it (What your
// group often asks failed on every server), so besides the runtime check this reads the code (docs/DECISIONS.md,
// "Bun 1.3.12 함정 두 개 더").
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from '../../server/src/db'

const ROOT = path.join(import.meta.dir, '..', '..')
const SHIPPED = ['server/src', 'shared/src', 'scripts']
/** an object key with a parameter prefix: `$from:` or a quoted `'$from':`, `':from':`, `'@from':` */
const PREFIXED_KEY = /(?:^|[{,])\s*(?:\$[A-Za-z_]\w*|(['"])[$:@][A-Za-z_]\w*\1)\s*:(?!:)/gm
/** JSON Schema's own `$` keywords are not SQL parameters */
const SCHEMA_KEY = /^\s*[{,]?\s*['"]?\$(ref|defs|schema|id|comment|anchor)\b/

describe('named parameters on the strict database', () => {
  test('keys without a prefix bind $name, :name and @name', () => {
    const db = openDb(':memory:')
    try {
      expect(db.query('SELECT $a AS a, :b AS b, @c AS c').get({ a: 1, b: 2, c: 3 })).toEqual({ a: 1, b: 2, c: 3 })
    } finally {
      db.close()
    }
  })

  test('the shipped code passes no binding object with a $, : or @ key', () => {
    const found: string[] = []
    for (const dir of SHIPPED) {
      for (const rel of fs.readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]) {
        if (!/\.(ts|tsx|js|mjs|cjs)$/.test(rel) || rel.split(path.sep).includes('node_modules')) continue
        const text = fs.readFileSync(path.join(ROOT, dir, rel), 'utf8')
        for (const m of text.matchAll(PREFIXED_KEY)) {
          if (!SCHEMA_KEY.test(m[0])) found.push(`${dir}/${rel}:${text.slice(0, m.index).split('\n').length}: ${m[0].trim()}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})
