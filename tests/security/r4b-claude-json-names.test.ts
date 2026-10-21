// Security regression, round 4b (finding 3, low): the ~/.claude.json siblings an office engine may write. Round 4
// anchored the name but still allowed any ".tmp.<anything>" and ".backup<anything>" next to it and anything in
// ~/.claude/backups: room for files every other chat's turn can read (a store between chats) and for names the CLI
// never writes. Now exactly what Claude Code 2.1.306 was seen to write in a real turn (sandbox report, docs/DECISIONS.md):
// .lock (a folder: its file lock), .tmp.<pid>.<12 hex> (atomic write), .backup (older versions) and
// ~/.claude/backups/.claude.json.backup.<milliseconds>. Fake home only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { localLoginBox, sbAvailable, type LocalLoginBox } from '../lib/sb-local-login'

let box: LocalLoginBox
beforeAll(() => { box = localLoginBox('mycel-r4b-names-') })
afterAll(() => box?.close())

describe.skipIf(!sbAvailable)('engine.sb LOCAL_LOGIN=1: ~/.claude.json siblings', () => {
  const at = (n: string) => path.join(box.home, n)
  test('what the CLI writes', () => {
    expect(box.run('c_me', {}, 'read', at('.claude.json'))).toBe(0)
    expect(box.run('c_me', {}, 'write', at('.claude.json'))).toBe(0)
    fs.writeFileSync(at('.claude.json'), '{}')
    expect(box.run('c_me', {}, 'mkdir', at('.claude.json.lock'))).toBe(0)
    expect(box.run('c_me', {}, 'write', at('.claude.json.tmp.84203.2b362fc2c16b'))).toBe(0)
    expect(box.run('c_me', {}, 'write', at('.claude.json.backup'))).toBe(0)
    expect(box.run('c_me', {}, 'write', at('.claude/backups/.claude.json.backup.1792575626838'))).toBe(0)
  })

  test('nothing else next to it or in the backups folder', () => {
    for (const n of [
      '.claude.json.tmp.x', '.claude.json.tmp.1.notHex', '.claude.json.tmp.4242.1761000000000', '.claude.json.tmp.a.0fcd31173c31',
      '.claude.json.backupX', '.claude.json.backup-r4b', '.claude.json.backup.1', '.claude.json.lockx',
      '.claude/backups/note.txt', '.claude/backups/.claude.json.backup.x1', '.claude/backups/.claude.json.corrupted.1792575626838',
    ]) expect([n, box.run('c_me', {}, 'write', at(n))]).toEqual([n, 1]) // all were 0
    // nor a folder in the backups folder (subpath allowed one before)
    expect(box.run('c_me', {}, 'mkdir', at('.claude/backups/stash'))).not.toBe(0) // was 0
  })
})
