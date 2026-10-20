// Component C tools through the real engine path: launcher -> fake engine -> mycel-bridge -> mycel-gate -> MCP socket
// -> tool registry (the same path a Claude Code / Codex turn uses). Needs `bun run build:native`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { startServer, type Running } from '../../server/src/server'
import { makeCApp, type CApp } from '../lib/c-app'
import { fakeTurn } from '../lib/run-turn'

let A: CApp
let core: Running
beforeAll(async () => {
  A = await makeCApp('c-e2e', [], { startCore: (ctx) => startServer(ctx.engineConfig, { db: ctx.db, files: ctx.files, launcher: { allowCmds: [process.execPath] } }) })
  core = await A.ctx.core()
})
afterAll(async () => { await A.close() })

test('make_file, share_file and artifact over the bridge; tools/list shows them', async () => {
  const chatId = A.chat('alice')
  const r = await fakeTurn(core, 'alice', { calls: [
    { tool: 'make_file', args: { content: '# 회의록\n\n| 안건 | 담당 |\n|---|---|\n| 예산 | Alice |\n', format: 'docx', output: 'users/alice/minutes.docx' } },
    { tool: 'share_file', args: { path: 'users/alice/minutes.docx', mode: 'download' } },
    { tool: 'artifact', args: { action: 'create', key: 'notes', type: 'markdown', content: '# notes' } },
    { tool: 'make_file', args: { content: '# x', format: 'docx', output: 'groups/finance/x.docx' } },
  ] }, { chatId })
  const tools = r.lines.find((l: any) => l.tools)?.tools
  expect(tools).toEqual(expect.arrayContaining(['read', 'make_file', 'share_file', 'artifact', 'web_fetch']))
  const [mk, share, art, denied] = r.results
  expect(mk.isError).toBe(false)
  expect(fs.existsSync(path.join(A.team, 'users/alice/minutes.docx'))).toBe(true)
  expect(share.text).toContain('/api/files/download?path=users%2Falice%2Fminutes.docx')
  expect(art.text).toContain('version 1')
  expect((await A.json(`/api/chats/${chatId}/artifacts`, { as: 'alice' })).body.items[0].key).toBe('notes')
  expect(denied.isError).toBe(true)
  const audit = A.ctx.db.query('SELECT tool, ok FROM tool_events WHERE turn_id = ? ORDER BY id').all(r.turnId) as any[]
  expect(audit.filter((a) => a.tool !== '(connect)').map((a) => [a.tool, a.ok])).toEqual([['make_file', 1], ['share_file', 1], ['artifact', 1], ['make_file', 0]])
}, 60_000)
