// The hosting service's trial AI credit was removed (docs/DECISIONS.md "Hosted trial AI credit removed (owner
// 2026-11-15)"). Migration 124 deletes its two settings rows (the encrypted key with its cap, and the dollars spent);
// the hosted speech key's rows stay. Data only: it does not raise the database's reader level.
import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, requiredReaderLevel } from '../../server/src/db'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

test('migration 124 removes the trial credit rows and nothing else; the reader level stays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-trial-gone-'))
  dirs.push(dir)
  const file = path.join(dir, 'app.db')
  let db = openDb(file)
  const level = requiredReaderLevel(db)
  // a database from before 124 that holds a trial key and its spend count, and the hosted speech key
  db.query('DELETE FROM schema_migrations WHERE version = 124').run()
  const put = db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  put.run('ai.hostedChatKey', JSON.stringify({ enc: 'x', keyVersion: 1, capUsd: 10, endsAt: '2026-11-18T15:00:00.000Z', enabled: true, updatedAt: '2026-11-04T00:00:00.000Z', kind: 'openrouter-api-key', refusedAt: null }))
  put.run('ai.hostedChatUsage', JSON.stringify({ usd: 1.25 }))
  put.run('speech.hostedKey', JSON.stringify({ enc: 'speech' }))
  db.close()
  db = openDb(file)
  try {
    expect(db.query("SELECT key FROM settings WHERE key IN ('ai.hostedChatKey', 'ai.hostedChatUsage')").all()).toEqual([])
    expect(db.query("SELECT value FROM settings WHERE key = 'speech.hostedKey'").get()).toEqual({ value: JSON.stringify({ enc: 'speech' }) })
    expect(db.query('SELECT min_compatible_reader AS r FROM schema_migrations WHERE version = 124').get()).toEqual({ r: 1 })
    expect(requiredReaderLevel(db)).toBe(level)
  } finally { db.close() }
})
