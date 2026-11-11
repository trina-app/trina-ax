// The knowledge graph was removed (docs/DECISIONS.md, 2026-11-11; plan docs/AGENTS/plan/20261111-0135-remove-knowledge-
// graph.md). What an older version left keeps working or goes once:
// - its data: <data>/knowledge-graph/ (copies of document text) and the meaning model in <data>/models are deleted at the
//   first start, with one line; a host's shared models folder is never touched
// - a server.json with `knowledgeGraph` still loads (the schema is strict): the key is ignored and logged once
// - its settings rows go with migration 339
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import { removeKnowledgeGraphData, start } from '../../server/src/main'
import type { Logger } from '../../server/src/log'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-kg-gone-')); dirs.push(d); return d }

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
  return { out, log, about: () => out.filter((l) => l.msg.includes('knowledge graph')) }
}

const put = (f: string, text = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }

/** an older version's data folder: the index (document text, a code copy) and the meaning model next to whisper's */
function oldData(data: string) {
  put(path.join(data, 'knowledge-graph', 'state.json'), '{}')
  put(path.join(data, 'knowledge-graph', 'documents', 'documents.db'), 'PRIVATE-DOCUMENT-TEXT')
  put(path.join(data, 'knowledge-graph', 'roots', 'abc', 'project', 'tree', 'src', 'main.ts'), 'code')
  put(path.join(data, 'models', 'Xenova', 'multilingual-e5-small', 'config.json'), '{}')
  put(path.join(data, 'models', 'Xenova', 'multilingual-e5-small', 'onnx', 'model_quantized.onnx'), 'onnx')
  put(path.join(data, 'models', 'whisper', 'ggml-base.bin'), 'whisper')
}

describe("the knowledge graph's data", () => {
  test('the index and the model go, with one info line; whisper stays; nothing the second time', async () => {
    const data = tmp()
    oldData(data)
    const l = lines()
    expect(await removeKnowledgeGraphData(data, l.log, {})).toBe(true)
    expect(fs.existsSync(path.join(data, 'knowledge-graph'))).toBe(false)
    expect(fs.existsSync(path.join(data, '.knowledge-graph-removing'))).toBe(false)
    expect(fs.existsSync(path.join(data, 'models', 'Xenova'))).toBe(false)
    expect(fs.readFileSync(path.join(data, 'models', 'whisper', 'ggml-base.bin'), 'utf8')).toBe('whisper')
    expect(l.out).toEqual([{ level: 'info', msg: expect.stringContaining('knowledge graph'), fields: { removed: ['knowledge-graph', 'models/Xenova/multilingual-e5-small'] } }])
    // a later start: nothing to do, nothing said
    expect(await removeKnowledgeGraphData(data, l.log, {})).toBe(false)
    expect(l.out).toHaveLength(1)
  })

  test('a data folder that never had it: nothing said', async () => {
    const l = lines()
    expect(await removeKnowledgeGraphData(tmp(), l.log, {})).toBe(false)
    expect(l.out).toEqual([])
  })

  test('another model of the same publisher stays, and so does its folder', async () => {
    const data = tmp()
    oldData(data)
    put(path.join(data, 'models', 'Xenova', 'other-model', 'config.json'), 'keep')
    expect(await removeKnowledgeGraphData(data, lines().log, {})).toBe(true)
    expect(fs.existsSync(path.join(data, 'models', 'Xenova', 'multilingual-e5-small'))).toBe(false)
    expect(fs.readFileSync(path.join(data, 'models', 'Xenova', 'other-model', 'config.json'), 'utf8')).toBe('keep')
  })

  test('links are removed themselves, never what they point to', async () => {
    const data = tmp(), elsewhere = tmp()
    put(path.join(elsewhere, 'index', 'keep.txt'), 'not ours')
    fs.symlinkSync(path.join(elsewhere, 'index'), path.join(data, 'knowledge-graph'))
    put(path.join(elsewhere, 'model', 'config.json'), 'not ours')
    fs.mkdirSync(path.join(data, 'models', 'Xenova'), { recursive: true })
    fs.symlinkSync(path.join(elsewhere, 'model'), path.join(data, 'models', 'Xenova', 'multilingual-e5-small'))
    const l = lines()
    expect(await removeKnowledgeGraphData(data, l.log, {})).toBe(true)
    expect(fs.existsSync(path.join(data, 'knowledge-graph'))).toBe(false)
    expect(fs.existsSync(path.join(data, 'models', 'Xenova', 'multilingual-e5-small'))).toBe(false)
    expect(fs.readFileSync(path.join(elsewhere, 'index', 'keep.txt'), 'utf8')).toBe('not ours')
    expect(fs.readFileSync(path.join(elsewhere, 'model', 'config.json'), 'utf8')).toBe('not ours')
    expect(l.about().map((x) => x.level)).toEqual(['info'])
  })

  test("a host's shared models folder is never touched, also when the data folder's models/ links to it", async () => {
    const data = tmp(), host = tmp()
    put(path.join(host, 'semantic', 'Xenova', 'multilingual-e5-small', 'config.json'), 'shared')
    put(path.join(host, 'Xenova', 'multilingual-e5-small', 'config.json'), 'shared')
    put(path.join(host, 'whisper', 'ggml-base.bin'), 'shared')
    fs.symlinkSync(host, path.join(data, 'models'))
    const l = lines()
    expect(await removeKnowledgeGraphData(data, l.log, { MYCEL_MODELS_DIR: host })).toBe(false)
    for (const f of ['semantic/Xenova/multilingual-e5-small/config.json', 'Xenova/multilingual-e5-small/config.json', 'whisper/ggml-base.bin'])
      expect(fs.readFileSync(path.join(host, f), 'utf8')).toBe('shared')
    expect(l.out).toEqual([])
    // the same through a real models/ folder whose Xenova/ links into the host's folder
    const data2 = tmp()
    fs.mkdirSync(path.join(data2, 'models'))
    fs.symlinkSync(path.join(host, 'Xenova'), path.join(data2, 'models', 'Xenova'))
    expect(await removeKnowledgeGraphData(data2, l.log, {})).toBe(false)
    expect(fs.readFileSync(path.join(host, 'Xenova', 'multilingual-e5-small', 'config.json'), 'utf8')).toBe('shared')
  })

  test('an index a stopped start had begun to delete is finished at the next', async () => {
    const data = tmp()
    put(path.join(data, '.knowledge-graph-removing', 'documents', 'documents.db'), 'PRIVATE-DOCUMENT-TEXT')
    const l = lines()
    expect(await removeKnowledgeGraphData(data, l.log, {})).toBe(true)
    expect(fs.existsSync(path.join(data, '.knowledge-graph-removing'))).toBe(false)
    expect(l.about().map((x) => x.level)).toEqual(['info'])
  })
})

/** a dev server's config file in `base`, with `extra` keys */
function config(base: string, extra: Record<string, unknown> = {}) {
  const data = path.join(base, 'data'), team = path.join(base, 'team')
  fs.mkdirSync(data, { recursive: true, mode: 0o700 })
  fs.mkdirSync(team, { recursive: true, mode: 0o700 })
  const conf = path.join(base, 'server.json')
  fs.writeFileSync(conf, JSON.stringify({ mode: 'dev', listen: { host: '127.0.0.1', port: 0 }, teamRoot: team, dataDir: data, ...extra }))
  return { conf, data }
}

describe('an older server.json', () => {
  test('knowledgeGraph loads (any value) and is named as obsolete; a file without it has nothing', () => {
    for (const value of [{ codegraph: '/opt/codegraph/bin/codegraph', meaning: false }, { meaning: true }, {}, '', null]) {
      const { conf } = config(tmp(), { knowledgeGraph: value })
      expect(loadAppConfig({ argv: ['--config', conf], env: {} }).obsoleteKeys).toEqual(['knowledgeGraph'])
    }
    const { conf } = config(tmp())
    expect(loadAppConfig({ argv: ['--config', conf], env: {} }).obsoleteKeys).toBeUndefined()
  })

  test('the start says so in one line, and deletes the old data in the background', async () => {
    const { conf, data } = config(tmp(), { knowledgeGraph: { meaning: false } })
    oldData(data)
    const l = lines()
    const s = await start(loadAppConfig({ argv: ['--config', conf], env: {} }), l.log)
    try {
      const obsolete = l.out.filter((x) => x.msg.includes('obsolete'))
      expect(obsolete.map((x) => x.level)).toEqual(['warn'])
      expect(obsolete[0]!.msg).toContain('"knowledgeGraph"')
      // the line comes once the background delete has ended
      const removed = () => l.about().filter((x) => x.msg.startsWith('removed'))
      for (let i = 0; i < 250 && !removed().length; i++) await Bun.sleep(20)
      expect(removed().map((x) => x.level)).toEqual(['info'])
      expect(fs.existsSync(path.join(data, 'knowledge-graph'))).toBe(false)
      expect(fs.existsSync(path.join(data, '.knowledge-graph-removing'))).toBe(false)
      expect(fs.existsSync(path.join(data, 'models', 'Xenova'))).toBe(false)
      expect(fs.existsSync(path.join(data, 'models', 'whisper', 'ggml-base.bin'))).toBe(true)
    } finally { await s.stop() }
  })
})

describe('migration 339', () => {
  test("removes the knowledge graph's settings rows and nothing else", () => {
    const file = path.join(tmp(), 'app.db')
    const keys = ['knowledgeGraph.enabled', 'knowledgeGraph.documents', 'knowledgeGraph.added']
    let db = openDb(file)
    // a database from before 339 that has the rows: 339 not yet applied
    db.query('DELETE FROM schema_migrations WHERE version = 339').run()
    for (const k of keys) db.query('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, k.endsWith('added') ? '["tools"]' : 'false')
    db.query("INSERT INTO settings (key, value) VALUES ('teamName', '\"acme\"') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    db.close()
    db = openDb(file)
    try {
      expect(db.query(`SELECT key FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`).all(...keys)).toEqual([])
      expect(db.query("SELECT value FROM settings WHERE key = 'teamName'").get()).toEqual({ value: '"acme"' })
      expect(db.query('SELECT 1 AS n FROM schema_migrations WHERE version = 339').get()).toEqual({ n: 1 })
    } finally { db.close() }
  })
})
