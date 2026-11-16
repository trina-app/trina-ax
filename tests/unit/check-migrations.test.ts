// `bun run check:migrations` (scripts/check-migrations.ts): two migrations with one number stop the server at start,
// and branches that add migrations at the same time used to find out only after both had merged.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { MIGRATION_FILE, MIGRATIONS_DIR } from '../../server/src/db'
import { MIGRATIONS_PATH, RANGES, filesAt, parse, problems } from '../../scripts/check-migrations'

const ROOT = path.resolve(import.meta.dir, '../..')
const BASE = ['001_init.sql', '002_foundation.sql', '127_a_x.sql', '299_b_x.sql', '357_c_x.sql', '409_b_x.sql', '600_f_relay.sql']

describe('check:migrations', () => {
  test('the migrations of this branch pass', () => {
    expect(problems(fs.readdirSync(MIGRATIONS_DIR).filter((f) => f !== '.DS_Store'))).toEqual([])
  })

  test('reads the folder the server reads', () => {
    expect(path.join(ROOT, MIGRATIONS_PATH)).toBe(MIGRATIONS_DIR)
  })

  test('a name is read as number and component; the foundation has no letter', () => {
    expect(parse('358_c_file_share_push_setting.sql')).toEqual({ file: '358_c_file_share_push_setting.sql', number: 358, component: 'c' })
    expect(parse('002_foundation.sql')).toEqual({ file: '002_foundation.sql', number: 2, component: '' })
  })

  test('two files with one number fail', () => {
    const bad = problems([...BASE, '358_c_one.sql', '358_c_two.sql'])
    expect(bad).toHaveLength(1)
    expect(bad[0]).toContain('two migrations with number 358: 358_c_one.sql, 358_c_two.sql')
  })

  test('a number outside its component range fails', () => {
    expect(problems(['358_b_chat.sql'])[0]).toContain("358 is outside component B's range (200–299, 400–499)")
    expect(problems(['410_c_files.sql'])[0]).toContain("outside component C's range (300–399)")
    expect(problems(['500_b_chat.sql'])).toHaveLength(1)
    // B's second range
    expect(problems(['410_b_chat.sql'])).toEqual([])
  })

  test('a number above 099 needs a known component letter', () => {
    expect(problems(['358_files.sql'])[0]).toContain('no component letter')
    expect(problems(['358_d_files.sql'])[0]).toContain('no component letter')
    expect(problems(['358_c.sql'])[0]).toContain('no component letter')
  })

  test('a name the runner would skip fails, and the check reads the names the runner applies', () => {
    for (const f of ['358-c-files.sql', '0358_c_files.sql', '358_C_files.sql', 'notes.txt']) {
      expect(MIGRATION_FILE.test(f)).toBe(false)
      expect(problems([f])[0]).toContain('the runner skips this name')
    }
    expect(MIGRATION_FILE.test('358_c_files.sql')).toBe(true)
  })

  test('on a pull request a new number must be above the highest of its component on the base', () => {
    // the next free numbers, a first file of a component, one more foundation file
    expect(problems([...BASE, '358_c_new.sql', '410_b_new.sql', '128_a_new.sql', '701_g_first.sql', '003_more.sql'], BASE)).toEqual([])
    // a free number below the highest
    const low = problems([...BASE, '350_c_new.sql'], BASE)
    expect(low).toHaveLength(1)
    expect(low[0]).toContain("350_c_new.sql: new number 350 is not above the base branch's highest for component C (357_c_x.sql)")
    // B's first range is behind its second
    expect(problems([...BASE, '250_b_new.sql'], BASE)).toHaveLength(1)
  })

  test('a number taken on the base by a PR that merged first fails as a shared number', () => {
    const merged = [...BASE, '358_c_theirs.sql']
    const bad = problems([...merged, '358_c_mine.sql'], merged)
    expect(bad).toHaveLength(1)
    expect(bad[0]).toContain('two migrations with number 358')
  })

  test('files the base already has are not compared, nor is anything without a base', () => {
    expect(problems(BASE, BASE)).toEqual([])
    expect(problems([...BASE, '350_c_new.sql'])).toEqual([])
    // a branch behind its base (a local run): the base's newer files are not this branch's problem
    expect(problems(BASE, [...BASE, '358_c_theirs.sql'])).toEqual([])
    // ... but its own new number below the base's newer ones is
    expect(problems([...BASE, '358_c_mine.sql'], [...BASE, '359_c_theirs.sql'])).toHaveLength(1)
  })

  test('the ranges do not overlap', () => {
    const all = Object.values(RANGES).flat().sort((x, y) => x[0] - y[0])
    for (let i = 1; i < all.length; i++) expect(all[i]![0]).toBeGreaterThan(all[i - 1]![1])
  })

  test('lists the folder at a git ref, and says why when it cannot', () => {
    expect(filesAt(ROOT, 'HEAD')).toContain('001_init.sql')
    const why: string[] = []
    expect(filesAt(ROOT, 'no-such-ref-for-check-migrations', (w) => why.push(w))).toBeNull()
    expect(why[0]).toContain('could not list server/migrations')
  })
})
