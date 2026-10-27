// Connected folders (server/src/team-files/connected.ts): which source folders may be connected, the one-way mirror
// into connected/<name> (new, changed, deleted), and that the mirror never overwrites or deletes what people put or
// changed there. Runs on the B harness (real DB, folder rules, team folder).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkName, checkSource, ConnectedError, ConnectedFolders } from '../../server/src/team-files/connected'
import { visiblePath } from '../../server/src/policy/authorize'
import { startHarness, type Harness } from '../lib/b-harness'

let h: Harness
let cf: ConnectedFolders
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-home-')))
const src = path.join(home, 'NAS-share')
const put = (rel: string, text: string, mtime?: number) => {
  const p = path.join(src, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text)
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000)
}
const team = (rel: string) => path.join(h.team, 'connected', 'nas', rel)
// the mirror's sources live in a temporary folder: on macOS any visible folder in the home may be connected; on Linux
// only folders below the mount roots (/mnt, /media, /srv), so here the temporary folder stands for such a root
beforeAll(async () => { h = await startHarness({ name: 'connected' }); cf = new ConnectedFolders(h.ctx, { home, linuxRoots: [home] }) })
afterAll(async () => { await h.close(); fs.rmSync(home, { recursive: true, force: true }) })

describe('what may be connected', () => {
  // the macOS rules (home, ~/Library, cloud folders) on every host; the Linux rules (mount roots, outside the install):
  // g-cloud-deployment.test.ts
  const o = () => ({ home, teamRoot: h.team, dataDir: h.dataDir, platform: 'darwin' as const })
  test('a visible folder in the home, /Volumes shares and cloud folders; not the home itself, hidden or Library', () => {
    fs.mkdirSync(path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-a@b.com', 'My Drive'), { recursive: true })
    fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true })
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    fs.mkdirSync(src, { recursive: true })
    expect(checkSource(src, o())).toBe(src)
    expect(checkSource(path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-a@b.com', 'My Drive'), o())).toContain('My Drive')
    for (const [p, code] of [[home, 'not_allowed'], [path.join(home, '.ssh'), 'hidden'], [path.join(home, 'Library', 'Keychains'), 'not_allowed'], ['relative/path', 'not_absolute'], [path.join(home, 'nope'), 'not_found'], [h.team, 'team_folder']] as const) {
      expect(() => checkSource(p, o())).toThrow(ConnectedError)
      try { checkSource(p, o()) } catch (e) { expect((e as Error).message).toBe(code) }
    }
    expect(() => checkName('../x')).toThrow(ConnectedError)
    expect(checkName(' 문서함 ')).toBe('문서함')
  })
})

describe('mirror', () => {
  test('connect: folder made, everyone can read it, files copied (hidden / links / bad names skipped)', async () => {
    put('회의록/2026-10-20.md', '주간 회의: 환불 규정 확정')
    put('price.csv', 'item,price\nA,100')
    put('.DS_Store', 'x')
    fs.symlinkSync('/etc/hosts', path.join(src, 'link-to-hosts'))
    const c = cf.add({ name: 'nas', source: src, actor: 'dion' })
    const r = await cf.sync(c.id)
    expect(r).toMatchObject({ copied: 2, updated: 0, removed: 0, files: 2 })
    expect(fs.readFileSync(team('회의록/2026-10-20.md'), 'utf8')).toBe('주간 회의: 환불 규정 확정')
    expect(fs.existsSync(team('.DS_Store'))).toBe(false)
    expect(fs.existsSync(team('link-to-hosts'))).toBe(false)
    const files = h.ctx.files
    expect(!!visiblePath(files.fx, files.rules(), files.principal('bob'), 'connected/nas/price.csv')).toBe(true)
    expect((await cf.sync(c.id))).toMatchObject({ copied: 0, updated: 0, removed: 0 })
  })
  test('changed and deleted at the source follow; what people changed or added here is kept', async () => {
    const c = cf.list()[0]!
    put('price.csv', 'item,price\nA,120', Date.now() + 5000)
    fs.rmSync(path.join(src, '회의록/2026-10-20.md'))
    fs.writeFileSync(team('my-note.md'), 'saved here by a person')
    put('kept.md', 'v1')
    await cf.sync(c.id)
    fs.writeFileSync(team('kept.md'), 'changed here')
    put('kept.md', 'v2 at the source', Date.now() + 10000)
    fs.rmSync(path.join(src, 'kept.md'), { force: true }); put('kept.md', 'v2 at the source', Date.now() + 10000)
    const r = await cf.sync(c.id)
    expect(fs.readFileSync(team('price.csv'), 'utf8')).toBe('item,price\nA,120')
    expect(fs.existsSync(team('회의록/2026-10-20.md'))).toBe(false)
    expect(fs.readFileSync(team('my-note.md'), 'utf8')).toBe('saved here by a person')
    expect(fs.readFileSync(team('kept.md'), 'utf8')).toBe('changed here')
    expect(r.kept).toBeGreaterThanOrEqual(1)
  })
  test('an unreadable source marks the folder as failed; disconnect removes only mirrored files', async () => {
    const c = cf.list()[0]!
    const moved = src + '-gone'
    fs.renameSync(src, moved)
    await expect(cf.sync(c.id)).rejects.toThrow('not_found')
    expect(cf.get(c.id)!.last_status).toBe('error')
    fs.renameSync(moved, src)
    await cf.sync(c.id)
    expect(cf.remove(c.id, 'dion')).toBe(true)
    expect(fs.existsSync(team('price.csv'))).toBe(false)
    expect(fs.readFileSync(team('my-note.md'), 'utf8')).toBe('saved here by a person')
    // the folder still holds a person's file: it and its rules stay
    expect(h.ctx.db.query("SELECT 1 AS x FROM folders WHERE path = 'connected/nas'").get()).toEqual({ x: 1 })
  })
  test('a mirror left empty on disconnect disappears with its rules row', async () => {
    const other = path.join(home, 'Other')
    fs.mkdirSync(path.join(other, 'sub'), { recursive: true }); fs.writeFileSync(path.join(other, 'sub', 'a.txt'), 'a')
    const c = cf.add({ name: 'other', source: other, actor: 'dion' })
    await cf.sync(c.id)
    expect(cf.remove(c.id, 'dion')).toBe(true)
    expect(fs.existsSync(path.join(h.team, 'connected', 'other'))).toBe(false)
    expect(h.ctx.db.query("SELECT 1 FROM folders WHERE path = 'connected/other'").get()).toBeNull()
  })
})
