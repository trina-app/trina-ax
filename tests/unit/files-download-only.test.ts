// The folder listing marks a download-only (quarantined) file, so the Files list and the attach picker can leave out
// "Ask AI" / "add to chat" with the reason (the AI's read refuses it: policy/authorize.ts). FileEntry.downloadOnly is
// additive: absent on every other entry. Exact-byte copies under another name are download-only too.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeCApp, type CApp } from '../lib/c-app'

let a: CApp
const deck = Buffer.from('PK generated deck bytes for the listing test')
beforeAll(async () => {
  a = await makeCApp('files-download-only')
  fs.mkdirSync(path.join(a.team, 'users/alice/out'), { recursive: true })
  fs.writeFileSync(path.join(a.team, 'users/alice/out/deck.pptx'), deck)
  fs.writeFileSync(path.join(a.team, 'users/alice/out/copy.pptx'), deck)
  fs.writeFileSync(path.join(a.team, 'users/alice/out/notes.md'), '# notes')
  fs.writeFileSync(path.join(a.team, 'users/alice/out/same-size.pptx'), Buffer.alloc(deck.length, 0x41))
  a.ctx.files.quarantine.add(deck, 'pptx')
}, 120_000)
afterAll(async () => { await a?.close() }, 120_000)

test('the folder listing marks download-only files and nothing else', async () => {
  const tree = await a.json('/api/files/tree?path=users%2Falice%2Fout', { as: 'alice' })
  expect(tree.status).toBe(200)
  const by = Object.fromEntries((tree.body.entries as { name: string; downloadOnly?: boolean }[]).map((e) => [e.name, e]))
  expect(by['deck.pptx']!.downloadOnly).toBe(true)
  expect(by['copy.pptx']!.downloadOnly).toBe(true) // the same bytes under another name
  expect('downloadOnly' in by['notes.md']!).toBe(false)
  expect('downloadOnly' in by['same-size.pptx']!).toBe(false) // same size, other bytes
  const parent = await a.json('/api/files/tree?path=users%2Falice', { as: 'alice' })
  expect((parent.body.entries as { name: string; downloadOnly?: boolean }[]).find((e) => e.name === 'out')!.downloadOnly).toBeUndefined()
  const found = await a.json('/api/files/find?q=deck', { as: 'alice' })
  expect(found.status).toBe(200)
  // name search and recent files (the attach picker) leave download-only files out altogether (visiblePath)
  expect((found.body.items as { path: string }[]).map((e) => e.path)).toEqual([])
  // the AI's read refuses the same file: the mark tells the truth
  const read = await a.ctx.files.call('read', { file_path: 'users/alice/out/deck.pptx' }, a.toolCtx('alice'))
  expect(read.isError).toBe(true)
  expect(read.text).toContain('다운로드 전용')
})
