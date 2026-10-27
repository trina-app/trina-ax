// Security regression (round 1, files-http #1): the near-duplicate name guard must never name, or tell apart, an
// entry the caller cannot see. alice (marketing) writes groups/marketing/ but groups/marketing/salaries/ is hidden from
// her by a 'none' rule. A look-alike probe ('ⓢalaries': U+24E2 folds to 's' under NFKC; 'SALARIES' on a
// case-sensitive volume) used to come back as 409 with error.fields.path = "'salaries' already exists with almost the
// same name ...", and the tool result handed the same text to the AI. Now a clash with a hidden sibling answers exactly
// like a path the caller may not access (plain 404 / "not found or no access: '<their own input>'") and nothing is
// created next to it; a clash with a visible sibling still gets the helpful near-duplicate answer.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { exists, jsonBody, makeCApp, type CApp } from '../lib/c-app'
import { authorize } from '../../server/src/policy/authorize'

// the app setup (database, migrations, team folder, server) takes seconds on a busy machine: room for it and the cases
setDefaultTimeout(30_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-hidden-name-clash') })
afterAll(async () => { await A.close() })

const HIDDEN = /salaries/ // the hidden folder's real spelling; probes never contain it in this case
const PROBE = 'ⓢalaries'
const DIR = 'groups/marketing'

const upload = (as: 'alice' | 'carol', name: string, onExists: 'fail' | 'rename' | 'replace' = 'fail') => {
  const fd = new FormData()
  fd.set('folder', DIR)
  fd.set('name', name)
  fd.set('onExists', onExists)
  fd.set('file', new File(['probe'], name))
  return A.json('/api/files/upload', { method: 'POST', body: fd, as })
}
const text = (r: { body: unknown }) => JSON.stringify(r.body)
const siblings = () => fs.readdirSync(path.join(A.team, DIR)).filter((n) => /alaries|ALARIES/.test(n)).sort()

describe('alice probes the hidden groups/marketing/salaries/ with a look-alike name', () => {
  test('setup: salaries/ is really hidden from alice and visible to carol', async () => {
    const t = await A.json('/api/files/tree?path=' + encodeURIComponent(DIR), { as: 'alice' })
    expect(t.status).toBe(200)
    expect(text(t)).not.toMatch(HIDDEN)
    expect((await A.json('/api/files/tree?path=' + encodeURIComponent(DIR + '/salaries'), { as: 'alice' })).status).toBe(404)
    expect(text(await A.json('/api/files/tree?path=' + encodeURIComponent(DIR), { as: 'carol' }))).toMatch(HIDDEN)
  })

  test('mkdir: plain 404, the hidden name is not in the answer, nothing created', async () => {
    const r = await A.json('/api/files/mkdir', { ...jsonBody({ path: `${DIR}/${PROBE}` }), as: 'alice' })
    expect(r.status).toBe(404)
    expect(text(r)).not.toMatch(HIDDEN)
    expect(siblings()).toEqual(['salaries'])
  })

  test('PUT content (also with a file below the probe): plain 404, no name', async () => {
    for (const p of [`${DIR}/${PROBE}`, `${DIR}/${PROBE}/notes.md`]) {
      const r = await A.json('/api/files/content', { ...jsonBody({ path: p, content: 'x', baseSha256: null }, 'PUT'), as: 'alice' })
      expect(r.status).toBe(404)
      expect(text(r)).not.toMatch(HIDDEN)
    }
    expect(siblings()).toEqual(['salaries'])
  })

  test('upload (fail and rename): plain 404, no name, no "ⓢalaries (2)" next to the hidden folder', async () => {
    for (const mode of ['fail', 'rename', 'replace'] as const) {
      const r = await upload('alice', PROBE, mode)
      expect(r.status).toBe(404)
      expect(text(r)).not.toMatch(HIDDEN)
    }
    expect(siblings()).toEqual(['salaries'])
  })

  test('move / rename onto the probe: plain 404, no name, nothing moved', async () => {
    for (const onExists of ['fail', 'rename'] as const) {
      const r = await A.json('/api/files/move', { ...jsonBody({ from: `${DIR}/campaign-brief.md`, to: `${DIR}/${PROBE}`, onExists }), as: 'alice' })
      expect(r.status).toBe(404)
      expect(text(r)).not.toMatch(HIDDEN)
    }
    expect(exists(A.team, `${DIR}/campaign-brief.md`)).toBe(true)
    expect(siblings()).toEqual(['salaries'])
  })

  test('the look-alike answer is the same as for the exact hidden name (no extra signal)', async () => {
    const exact = await A.json('/api/files/mkdir', { ...jsonBody({ path: `${DIR}/salaries` }), as: 'alice' })
    const look = await A.json('/api/files/mkdir', { ...jsonBody({ path: `${DIR}/${PROBE}` }), as: 'alice' })
    expect(look.status).toBe(exact.status)
    const strip = (b: any) => ({ ...b, error: { ...b.error, requestId: undefined } })
    expect(strip(look.body)).toEqual(strip(exact.body))
  })

  test('file tools: the AI gets "not found or no access" with only the typed path, the rejected event names nothing', async () => {
    const before = (A.ctx.db.query('SELECT MAX(id) AS m FROM file_events').get() as { m: number | null }).m ?? 0
    for (const file_path of [`${DIR}/${PROBE}`, `${DIR}/${PROBE}/x.md`]) {
      const out = await A.ctx.files.call('write', { file_path, content: 'x' }, A.toolCtx('alice'))
      expect(out.isError).toBe(true)
      expect(out.text).toContain('not found or no access')
      expect(out.text + out.summary).not.toMatch(HIDDEN)
    }
    const ev = A.ctx.db.query('SELECT path, detail FROM file_events WHERE id > ?').all(before) as { path: string; detail: string | null }[]
    expect(JSON.stringify(ev)).not.toMatch(HIDDEN)
    expect(siblings()).toEqual(['salaries'])
  })
})

describe('case-sensitive volume (Linux): an upper-case probe', () => {
  test('SALARIES: plain 404 over HTTP and in the tool result', async () => {
    const fx = A.ctx.files.fx
    const was = fx.caseInsensitive
    fx.caseInsensitive = false // what detectCaseInsensitive reports on ext4: the walk no longer folds case
    try {
      const r = await A.json('/api/files/mkdir', { ...jsonBody({ path: `${DIR}/SALARIES` }), as: 'alice' })
      expect(r.status).toBe(404)
      expect(text(r)).not.toMatch(HIDDEN)
      const fd = await A.json('/api/files/content', { ...jsonBody({ path: `${DIR}/SALARIES/2026.md`, content: 'x', baseSha256: null }, 'PUT'), as: 'alice' })
      expect(fd.status).toBe(404)
      expect(text(fd)).not.toMatch(HIDDEN)
      const out = await A.ctx.files.call('write', { file_path: `${DIR}/SALARIES`, content: 'x' }, A.toolCtx('alice'))
      expect(out.text + out.summary).not.toMatch(HIDDEN)
      expect(() => authorize(fx, A.ctx.files.rules(), A.ctx.files.principal('alice'), `${DIR}/SALARIES`, 'write')).toThrow(/^not found or no access: 'groups\/marketing\/SALARIES'$/)
    } finally { fx.caseInsensitive = was }
    expect(siblings()).toEqual(['salaries'])
  })
})

describe('auto-naming does not step around hidden names either', () => {
  // a hidden folder that takes the first free name: "plan (2)" with a rule only finance can see
  beforeAll(() => {
    fs.writeFileSync(path.join(A.team, DIR, 'plan'), 'visible\n')
    fs.mkdirSync(path.join(A.team, DIR, 'plan (2)'))
    fs.writeFileSync(path.join(A.team, DIR, 'plan (2)', 'x.md'), 'hidden\n')
    A.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_plan2', ?)").run(`${DIR}/plan (2)`)
    A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_plan2', 'f_plan2', 'group', 'marketing', 'none')").run()
  })
  const plans = () => fs.readdirSync(path.join(A.team, DIR)).filter((n) => n.startsWith('plan')).sort()

  test('upload onExists=rename: no "plan (3)" that would reveal the hidden "plan (2)"', async () => {
    const r = await upload('alice', 'plan', 'rename')
    expect(r.status).toBe(404)
    expect(text(r)).not.toContain('plan (2)')
    expect(plans()).toEqual(['plan', 'plan (2)'])
  })

  test('move onExists=rename: the same', async () => {
    fs.writeFileSync(path.join(A.team, 'users/alice/plan'), 'mine\n')
    const r = await A.json('/api/files/move', { ...jsonBody({ from: 'users/alice/plan', to: `${DIR}/plan`, onExists: 'rename' }), as: 'alice' })
    expect(r.status).toBe(404)
    expect(text(r)).not.toContain('plan (2)')
    expect(plans()).toEqual(['plan', 'plan (2)'])
    expect(exists(A.team, 'users/alice/plan')).toBe(true)
  })

  test('trash restore: a name now held by a hidden look-alike is refused like no access, not renamed around it', async () => {
    const save = await A.json('/api/files/content', { ...jsonBody({ path: `${DIR}/ⓡoster`, content: 'mine', baseSha256: null }, 'PUT'), as: 'alice' })
    expect(save.status).toBe(200)
    const del = await A.json('/api/files?path=' + encodeURIComponent(`${DIR}/ⓡoster`), { method: 'DELETE', as: 'alice' })
    expect(del.status).toBe(200)
    // meanwhile an admin makes a folder 'roster' that marketing may not see
    fs.mkdirSync(path.join(A.team, DIR, 'roster'))
    A.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_roster', ?)").run(`${DIR}/roster`)
    A.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_roster', 'f_roster', 'group', 'marketing', 'none')").run()
    const r = await A.json(`/api/files/trash/${del.body.trashId}/restore`, { method: 'POST', as: 'alice' })
    expect(r.status).toBe(404)
    expect(text(r)).not.toMatch(/roster/)
    expect(fs.readdirSync(path.join(A.team, DIR)).filter((n) => /oster/.test(n))).toEqual(['roster'])
  })

  test('carol, who sees "plan (2)", still gets "plan (3)"', async () => {
    const r = await upload('carol', 'plan', 'rename')
    expect(r.status).toBe(201)
    expect(r.body.name).toBe('plan (3)')
  })
})

describe('legitimate near-duplicates still get the helpful answer', () => {
  test('carol (admin, sees salaries/) is told it is a near-duplicate', async () => {
    const r = await A.json('/api/files/mkdir', { ...jsonBody({ path: `${DIR}/${PROBE}` }), as: 'carol' })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('conflict')
  })
  test('a visible sibling: 409 near-duplicate over HTTP (no raw policy text in fields), the tool still names it for the AI', async () => {
    const r = await A.json('/api/files/mkdir', { ...jsonBody({ path: 'shared/ｇｌｏｓｓａｒｙ.md' }), as: 'alice' })
    expect(r.status).toBe(409)
    expect(text(r)).not.toContain('already exists with almost the same name')
    const out = await A.ctx.files.call('write', { file_path: 'shared/ｇｌｏｓｓａｒｙ.md', content: 'x' }, A.toolCtx('alice'))
    expect(out.isError).toBe(true)
    expect(out.text).toContain("'glossary.md' already exists with almost the same name")
  })
  test('a clearly different name next to the hidden folder still works', async () => {
    const r = await A.json('/api/files/mkdir', { ...jsonBody({ path: `${DIR}/ⓢecrets` }), as: 'alice' })
    expect(r.status).toBe(201)
  })
})

describe('reads never scan for look-alikes (security r2)', () => {
  // the guard exists to stop *creating* a look-alike; a read of a missing path (GET /api/files/history asks with
  // mustExist:false) that ran it answered "no access" for a hidden look-alike and "nothing here" for any other name
  test('a read of a missing look-alike of the hidden folder is just a missing path', () => {
    const alice = A.ctx.files.principal('alice')
    for (const p of [`${DIR}/${PROBE}`, `${DIR}/ſalaries`]) {
      const r = authorize(A.ctx.files.fx, A.ctx.files.rules(), alice, p, 'read', { mustExist: false })
      expect(r.exists).toBe(false)
      expect(r.rel).toBe(p)
    }
  })
  test('the create guard is unchanged for writes', () => {
    expect(() => authorize(A.ctx.files.fx, A.ctx.files.rules(), A.ctx.files.principal('alice'), `${DIR}/ſalaries`, 'write', { mustExist: false }))
      .toThrow(/^not found or no access/)
    expect(() => authorize(A.ctx.files.fx, A.ctx.files.rules(), A.ctx.files.principal('carol'), `${DIR}/ſalaries`, 'write', { mustExist: false }))
      .toThrow(/almost the same name/)
  })
})
