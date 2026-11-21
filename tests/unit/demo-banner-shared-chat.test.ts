// The demo's change_banner_text in a shared project chat (demo re-test 2026-11-22 P1): it was missing from SHARED_TOOLS
// (rooms/ai-tools.ts), so the 유자 진저 project chat never had it; the AI took 13 steps, saved a junk
// 런칭배너_큰햇살.svg and made no banner. Covered: on a demo server with a banner kit, a shared project chat offers the
// tool, and calling it there saves the banner into the project folder with no card (a new file in the project's own
// folder: everyone who sees the chat sees that folder) and says nothing about another person's folder. Fake data only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { writeSteepling } from '../../scripts/demo/steepling/make'
import { demoFakesOf } from '../../server/src/demo/fakes'
import { findTypst } from '../../server/src/demo/fakes/banner'
import { DEMO_BANNER_TOOL } from '../../server/src/tools/demo-banner'
import { SAVE_CARD_TOOLS, SHARED_TOOLS, WRITE_TARGET_ARGS } from '../../server/src/rooms/ai-tools'
import { toolRegistry } from '../../server/src/tools/registry'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const drawing = findTypst() ? test : test.skip

let h: Harness
let ws: TestSocket
let projectId: string
const content = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-banner-shared-'))
beforeAll(async () => {
  h = await startHarness({ name: 'demo-banner-shared-chat', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  ws = await h.ws('alice'); await ws.next('hello')
  const p = await oldProject(h, 'alice', { name: '유자 진저', folderPath: 'projects/falcon', instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  // a demo server with Steepling's banner kit (as tests/unit/demo-banner.test.ts), from here on
  writeSteepling('ko', content)
  ;(h.ctx.config as any).demo = { company: 'Steepling', password: 'demo-password-1', personas: [], fakes: { content: path.join(content, 'fakes') } }
  expect(demoFakesOf(h.ctx)?.banners.ready).toBe(true)
})
afterAll(async () => { ws?.close(); await h?.close(); fs.rmSync(content, { recursive: true, force: true }) })

const ask = async (chatId: string, content: string) => {
  const sent = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  return (await ws.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 60_000)).data.message as { content: string; status: string }
}
const projectChat = async () => (await h.api('alice').call(API.createChat, { body: { projectId } })).id

describe('change_banner_text in a shared project chat', () => {
  test('it is on the shared list, with its save target and save card', async () => {
    expect(SHARED_TOOLS.has(DEMO_BANNER_TOOL)).toBe(true)
    expect(WRITE_TARGET_ARGS[DEMO_BANNER_TOOL]).toEqual(['save_as'])
    expect(SAVE_CARD_TOOLS[DEMO_BANNER_TOOL]).toBe('one')
    expect(toolRegistry(h.ctx.files).available(DEMO_BANNER_TOOL)).toBe(true)
  })

  test('the shared project chat offers it', async () => {
    const chat = await projectChat()
    const r = await ask(chat, 'tools?\n' + fake({ echo: 'tools' }))
    const offered = r.content.split(',').map((t) => t.replace(/^mcp__team__/, ''))
    expect(offered).toContain(DEMO_BANNER_TOOL)
  })

  drawing('calling it there saves the banner into the project folder, with no card', async () => {
    const chat = await projectChat()
    const before = new Set(fs.existsSync(path.join(h.ctx.files.fx.root, 'projects/falcon')) ? fs.readdirSync(path.join(h.ctx.files.fx.root, 'projects/falcon')) : [])
    const from = ws.frames.length
    const r = await ask(chat, '헤드라인을 작지 않아 큰 햇살이야!로 바꿔 줘\n' + fake({ tool: DEMO_BANNER_TOOL, args: { headline: '작지 않아 큰 햇살이야!' }, sayResult: true }))
    expect(r.status).toBe('done')
    // no card came up (a new file in the project's own folder)
    expect(ws.frames.slice(from).filter((f) => f.type === 'turn.request')).toEqual([])
    const view = JSON.parse(r.content.split('\n').find((l) => l.startsWith('{"saved"'))!)
    expect(view.saved.startsWith('projects/falcon/banner-1200x628-')).toBe(true)
    expect(view.words.headline).toBe('작지 않아 큰 햇살이야!')
    const added = fs.readdirSync(path.join(h.ctx.files.fx.root, 'projects/falcon')).filter((n) => !before.has(n))
    expect(added).toEqual([view.saved.split('/').pop()])
    expect(fs.readFileSync(path.join(h.ctx.files.fx.root, view.saved)).subarray(1, 4).toString()).toBe('PNG')
    expect(r.content).toContain(`](/api/files/download?path=${encodeURIComponent(view.saved)})`)
  })
})
