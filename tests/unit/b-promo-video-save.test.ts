// save_promo_video (AI flow check FL-16, QA TC-3817): the chat's promo video saved as an .mp4 in the team folder, so
// it can be sent or shared like any file. The same render as the preview's MP4 (a stand-in CLI here); placed with the
// rules of every file the AI makes (write access, conflict copy, audit), the wider-audience card for its material, never
// under skills/. Where the MP4 cannot be rendered the tool is not offered and the AI is told to say so plainly.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { stepLabel } from '../../shared/src/step-labels'
import { mp4Available } from '../../server/src/promo-video/render'
import { SAVE_PROMO_TOOL, setSavePollForTests, videoSources } from '../../server/src/promo-video/save'
import { PROMO_TOOL_DESCRIPTION } from '../../server/src/promo-video/tool'
import { outsideContentTool } from '../../server/src/chat/team-content-tools'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'
import { toolRegistry } from '../../server/src/tools/registry'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
const onMac = process.platform === 'darwin' && !!Bun.which('node')

function png(w: number, h: number, pad = 4096): Buffer {
  const b = Buffer.alloc(33 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b, 0)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[24] = 8; b[25] = 6
  return b
}

let h: Harness
const hfDir = path.join(os.tmpdir(), `mycel-hf-save-${process.pid}`)
const put = (rel: string, b: Buffer | string) => { fs.mkdirSync(path.dirname(path.join(h.team, rel)), { recursive: true }); fs.writeFileSync(path.join(h.team, rel), b) }
const team = (rel: string) => path.join(h.team, ...rel.split('/'))

beforeAll(async () => {
  process.env.MYCEL_HYPERFRAMES_DIR = path.join(hfDir, 'none')
  setSavePollForTests(50)
  h = await startHarness({ name: 'b-promo-video-save', askUserTimeoutMs: 2000 })
  put('shared/Brand/Company intro.md', '# Acme\n\nAcme cuts factory power bills. 87 plants use it; the bill fell by 18% on average (2025 customers).\nWebsite: acme.example\n')
  put('users/dana/notes/intro.md', '# Acme\n\nAcme cuts factory power bills. 87 plants use it; the bill fell by 18% on average (2025 customers).\nWebsite: acme.example\n')
  put('shared/Brand/Images/factory.png', png(1600, 1200))
  put('shared/Brand/Images/logo.png', png(600, 160))
  // a stand-in for the HyperFrames CLI: writes a small file where --output says
  const cli = path.join(hfDir, 'ok', 'node_modules', 'hyperframes', 'bin')
  fs.mkdirSync(cli, { recursive: true })
  fs.writeFileSync(path.join(cli, 'hyperframes.mjs'), `import fs from 'node:fs'
const a = process.argv.slice(2)
fs.writeFileSync(a[a.indexOf('--output') + 1], 'MP4-BYTES')
`)
})
afterAll(async () => { setSavePollForTests(null); await h?.close(); fs.rmSync(hfDir, { recursive: true, force: true }); delete process.env.MYCEL_HYPERFRAMES_DIR })

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const send = async (user: string, chatId: string, content: string) => {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 45_000 })
  return (h.ctx.db.query('SELECT content FROM messages WHERE id = ?').get(r.assistantMessage.id) as { content: string }).content
}
const slots = (over: Record<string, unknown> = {}) => ({
  title: 'Acme promo video', company: 'Acme', website: 'acme.example', brand_color: '#0E5E4E', logo: 'shared/Brand/Images/logo.png',
  sources: ['shared/Brand/Company intro.md'],
  hook: { label: 'Your power bill', before: 'Guesswork', after: '18%', line: 'Customers as of 2025' },
  promise: { headline: ['See where the power', '*goes*'], sub: 'Live power data for every machine.', picture: 'shared/Brand/Images/factory.png' },
  work: { kicker: 'Factory energy', headline: ['One sensor', 'per machine'], points: ['Live usage', 'Leak alerts'] },
  proof: { stats: [{ number: '18%', label: 'lower power bill' }, { number: '87', label: 'plants' }] },
  cta: { line: 'Factory energy partner', offer: 'Free audit' },
  ...over,
})

describe('save_promo_video', () => {
  test('where the MP4 cannot be rendered: not offered, and the AI is told to say so plainly', async () => {
    expect(mp4Available(h.ctx)).toBe(false)
    expect(toolRegistry(h.ctx.files).available(SAVE_PROMO_TOOL)).toBe(false)
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    const answer = await send('dana', chat.id, fake({ tool: 'promo_video', args: slots(), sayResult: true }))
    expect(answer).toContain('This server cannot save the video as a file (only this preview; the video tools are not installed on this server (yet))')
    expect(PROMO_TOOL_DESCRIPTION).toContain('The length is always 18.5 s')
  })

  test.if(onMac)('the video saved in the person\'s own folder by default, a new version over a file read in this turn never silently', async () => {
    process.env.MYCEL_HYPERFRAMES_DIR = path.join(hfDir, 'ok')
    expect(toolRegistry(h.ctx.files).available(SAVE_PROMO_TOOL)).toBe(true)
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    const made = await send('dana', chat.id, fake({ tool: 'promo_video', args: slots(), sayResult: true }))
    expect(made).toContain(`call ${SAVE_PROMO_TOOL} first`)
    const saved = await send('dana', chat.id, fake({ tool: SAVE_PROMO_TOOL, args: {}, sayResult: true }))
    expect(saved).toContain('Saved the video as users/dana/videos/Acme promo video.mp4')
    expect(saved).toContain('use share_with_person or post_to_room with this path')
    expect(fs.readFileSync(team('users/dana/videos/Acme promo video.mp4'), 'utf8')).toBe('MP4-BYTES')
    const ev = h.ctx.db.query('SELECT user_id, action, detail FROM file_events WHERE path = ? ORDER BY id DESC').get('users/dana/videos/Acme promo video.mp4') as { user_id: string; action: string; detail: string }
    expect(ev).toMatchObject({ user_id: 'dana', action: 'create' })
    expect(JSON.parse(ev.detail).tool).toBe(SAVE_PROMO_TOOL)
    // again, not read in this turn: a conflict copy, the first file kept
    const again = await send('dana', chat.id, fake({ tool: SAVE_PROMO_TOOL, args: {}, sayResult: true }))
    expect(again).toContain("'users/dana/videos/Acme promo video.mp4' already exists and was not read in this turn")
  })

  test.if(onMac)('a named place: saved there; a skills folder or a folder the person cannot write is refused, nothing saved', async () => {
    process.env.MYCEL_HYPERFRAMES_DIR = path.join(hfDir, 'ok')
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    await send('dana', chat.id, fake({ tool: 'promo_video', args: slots(), sayResult: true }))
    const ok = await send('dana', chat.id, fake({ tool: SAVE_PROMO_TOOL, args: { save_as: 'shared/Videos/acme' }, sayResult: true }))
    expect(ok).toContain('Saved the video as shared/Videos/acme.mp4')
    const folder = await send('dana', chat.id, fake({ tool: SAVE_PROMO_TOOL, args: { save_as: 'shared/Videos/' }, sayResult: true }))
    expect(folder).toContain('Saved the video as shared/Videos/Acme promo video.mp4')
    const skills = await send('dana', chat.id, fake({ tool: SAVE_PROMO_TOOL, args: { save_as: 'skills/promo/acme.mp4' }, sayResult: true }))
    expect(skills).toContain('videos cannot be saved in a skills folder')
    expect(fs.existsSync(team('skills/promo/acme.mp4'))).toBe(false)
    const other = await send('dana', chat.id, fake({ tool: SAVE_PROMO_TOOL, args: { save_as: 'users/bob/acme.mp4' }, sayResult: true }))
    expect(fs.existsSync(team('users/bob/acme.mp4'))).toBe(false)
    expect(other).not.toContain('Saved the video')
    expect(other).toContain('not found or no access')
  })

  test.if(onMac)('material only the person can read: a save where more people can read asks first (declined: nothing saved)', async () => {
    process.env.MYCEL_HYPERFRAMES_DIR = path.join(hfDir, 'ok')
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    await send('dana', chat.id, fake({ tool: 'promo_video', args: slots({ sources: ['users/dana/notes/intro.md'] }), sayResult: true }))
    const r = await send('dana', chat.id, fake({ tool: SAVE_PROMO_TOOL, args: { save_as: 'shared/Videos/private-material.mp4' }, sayResult: true }))
    expect(r).toContain('more people can see that folder')
    expect(fs.existsSync(team('shared/Videos/private-material.mp4'))).toBe(false)
    expect(r).not.toContain('Saved the video')
  })

  test('no promo video in the chat: told to make one first', async () => {
    process.env.MYCEL_HYPERFRAMES_DIR = path.join(hfDir, onMac ? 'ok' : 'none')
    if (!onMac) return
    const chat = await h.api('dana').call(API.createChat, { body: {} })
    const r = await send('dana', chat.id, fake({ tool: SAVE_PROMO_TOOL, args: {}, sayResult: true }))
    expect(r).toContain('There is no promo video in this chat yet')
  })

  test('the material and pictures are its sources; a parent-only, team-content tool with a step label', () => {
    const doc = { logo: { src: '/shared/Brand/Images/logo.png' }, promise: { picture: { src: '/shared/Brand/Images/factory.png' } }, work: { picture: null }, proof: { picture: null } }
    expect(videoSources({ title: 't', sources: ['shared/Brand/Company intro.md'], doc } as never)).toEqual(['shared/Brand/Company intro.md', 'shared/Brand/Images/logo.png', 'shared/Brand/Images/factory.png'])
    expect(outsideContentTool(SAVE_PROMO_TOOL)).toBe(false)
    expect(PARENT_ONLY_TOOLS.has(SAVE_PROMO_TOOL)).toBe(true)
    expect(stepLabel(SAVE_PROMO_TOOL, { save_as: 'shared/Videos/acme.mp4' }, 'en', new Set())).toContain('Save promo video as a file · shared/Videos/acme.mp4')
  })
})
