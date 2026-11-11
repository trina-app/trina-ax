// The removed search by meaning tool (`search`, docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md wave 3
// step 17): the first start of a version without it deletes its index, <data>/semantic.db with SQLite's WAL files, and
// says so in one info line; later starts find nothing. The model folder it downloaded goes with the knowledge graph's
// data at the same start (tests/unit/knowledge-graph-removed.test.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAppConfig } from '../../server/src/app-config'
import { removeOldSemanticIndex, start } from '../../server/src/main'
import type { Logger } from '../../server/src/log'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-semdb-')); dirs.push(d); return d }

/** a logger that keeps every line */
function lines() {
  const out: { level: string; msg: string; fields?: Record<string, unknown> }[] = []
  const log: Logger = {
    debug: (msg, fields) => { out.push({ level: 'debug', msg, fields }) },
    info: (msg, fields) => { out.push({ level: 'info', msg, fields }) },
    warn: (msg, fields) => { out.push({ level: 'warn', msg, fields }) },
    error: (msg, fields) => { out.push({ level: 'error', msg, fields }) },
    child: () => log,
  }
  return { out, log, about: () => out.filter((l) => l.msg.includes('semantic.db')) }
}

/** an old data folder: the index with its WAL files, and the downloaded model */
function oldData(data: string) {
  fs.writeFileSync(path.join(data, 'semantic.db'), 'x'.repeat(100))
  fs.writeFileSync(path.join(data, 'semantic.db-wal'), 'y'.repeat(20))
  fs.writeFileSync(path.join(data, 'semantic.db-shm'), 'z'.repeat(3))
  const model = path.join(data, 'models', 'Xenova', 'multilingual-e5-small', 'config.json')
  fs.mkdirSync(path.dirname(model), { recursive: true })
  fs.writeFileSync(model, '{}')
  return model
}

describe('the old semantic.db', () => {
  test('deleted with its WAL files, one info line; the model is not this step\'s; nothing the second time', () => {
    const data = tmp()
    const model = oldData(data)
    const l = lines()
    expect(removeOldSemanticIndex(data, l.log)).toBe(true)
    for (const n of ['semantic.db', 'semantic.db-wal', 'semantic.db-shm']) expect(fs.existsSync(path.join(data, n))).toBe(false)
    expect(fs.readFileSync(model, 'utf8')).toBe('{}')
    expect(l.out).toEqual([{ level: 'info', msg: expect.stringContaining('semantic.db'), fields: { bytes: 123 } }])
    // a later start: nothing to do, nothing said
    expect(removeOldSemanticIndex(data, l.log)).toBe(false)
    expect(l.out).toHaveLength(1)
  })

  test('a data folder that never had it: nothing said', () => {
    const l = lines()
    expect(removeOldSemanticIndex(tmp(), l.log)).toBe(false)
    expect(l.out).toEqual([])
  })

  test('a link in its place is removed itself, never what it points to', () => {
    const data = tmp()
    const target = path.join(tmp(), 'keep.db')
    fs.writeFileSync(target, 'not ours')
    fs.symlinkSync(target, path.join(data, 'semantic.db'))
    const l = lines()
    expect(removeOldSemanticIndex(data, l.log)).toBe(true)
    expect(fs.existsSync(path.join(data, 'semantic.db'))).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('not ours')
    expect(l.about().map((x) => x.level)).toEqual(['info'])
  })

  test('the server start deletes it, and the model with the knowledge graph\'s data', async () => {
    const base = tmp()
    const data = path.join(base, 'data'), team = path.join(base, 'team')
    fs.mkdirSync(data, { recursive: true, mode: 0o700 })
    fs.mkdirSync(team, { recursive: true, mode: 0o700 })
    const model = oldData(data)
    const conf = path.join(base, 'server.json')
    fs.writeFileSync(conf, JSON.stringify({ mode: 'dev', listen: { host: '127.0.0.1', port: 0 }, teamRoot: team, dataDir: data }))
    const l = lines()
    const s = await start(loadAppConfig({ argv: ['--config', conf], env: {} }), l.log)
    try {
      expect(fs.existsSync(path.join(data, 'semantic.db'))).toBe(false)
      expect(fs.existsSync(path.join(data, 'semantic.db-wal'))).toBe(false)
      expect(fs.existsSync(model)).toBe(false)
      expect(l.about().map((x) => x.level)).toEqual(['info'])
    } finally { await s.stop() }
  })
})
