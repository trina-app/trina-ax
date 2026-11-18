// What one answer may write (docs/decisions/20261118-limits-caps.md, QA TC-4903): a member 1 GB / 2,000 files, a
// guest the old 50 MB / 200. The disk floor (system/storage.ts) is the disk guard, not these numbers.
import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import { makeEnv } from '../lib/env'
import { defaultConfig } from '../../server/src/config'
import { turnWriteLimits } from '../../server/src/files/turn-write-limits'
import { TurnFiles } from '../../server/src/files/service'

const e = makeEnv('turn-write-limits')
afterAll(() => { e.db.close(); fs.rmSync(e.fx.base, { recursive: true, force: true }) })

test('the defaults: members 1 GB and 2,000 files per answer, guests 50 MB and 200 (was 50 MB and 200 for everyone)', () => {
  const c = defaultConfig({ teamRoot: e.fx.team, dataDir: e.fx.data })
  expect([c.maxWriteBytesPerTurn, c.maxFilesWrittenPerTurn]).toEqual([1024 ** 3, 2000])
  expect([c.guestMaxWriteBytesPerTurn, c.guestMaxFilesWrittenPerTurn]).toEqual([50 * 1024 ** 2, 200])
  expect(turnWriteLimits(c, e.db, 'alice')).toEqual({ bytes: 1024 ** 3, files: 2000 })
  e.db.query('UPDATE users SET guest = 1 WHERE id = ?').run('erin')
  try { expect(turnWriteLimits(c, e.db, 'erin')).toEqual({ bytes: 50 * 1024 ** 2, files: 200 }) } finally { e.db.query('UPDATE users SET guest = 0 WHERE id = ?').run('erin') }
})

test('a member writes 250 files in one answer; a guest stops at 200 with "continue in the next message"', () => {
  const member = { ...e.ctx('alice', 't-member'), files: new TurnFiles() }
  for (let i = 0; i < 250; i++) {
    const r = e.files.write(member, { file_path: `groups/marketing/many/m-${i}.md`, content: 'x' })
    expect(r.isError, r.text).toBeFalsy()
  }
  e.db.query('UPDATE users SET guest = 1 WHERE id = ?').run('erin')
  // a guest writes only in their one project, by a person rule
  e.db.query("INSERT INTO projects (id, name, folder_path, created_by) VALUES ('p-gw', 'gw', 'projects/gw', 'alice')").run()
  e.db.query("INSERT INTO guests (user_id, place_kind, place_id, project_id, created_at) VALUES ('erin', 'project', 'p-gw', 'p-gw', '2026-11-18T00:00:00Z')").run()
  e.db.query("INSERT INTO folders (id, path) VALUES ('f_gw', 'projects/gw')").run()
  e.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_gw', 'f_gw', 'user', 'erin', 'write')").run()
  fs.mkdirSync(`${e.fx.team}/projects/gw`, { recursive: true })
  try {
    const guest = { ...e.ctx('erin', 't-guest'), files: new TurnFiles() }
    let refused = ''
    for (let i = 0; i < 201 && !refused; i++) {
      try {
        const r = e.files.write(guest, { file_path: `projects/gw/g-${i}.md`, content: 'x' })
        if (r.isError) refused = r.text
      } catch (x) { refused = String((x as Error).message) }
    }
    expect(refused).toContain('at most 200 files written in one answer')
    expect(guest.files.filesWritten.size).toBe(200)
  } finally { e.db.query('UPDATE users SET guest = 0 WHERE id = ?').run('erin') }
})
