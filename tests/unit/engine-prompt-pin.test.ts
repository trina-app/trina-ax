// The Claude Code and Codex login paths keep their instructions and tools byte for byte while the API engine's prompt
// changes (docs/AGENTS/plan/20261120-2120-api-engine-diet-ollama.md, docs/decisions/20261120-api-engine-stable-prompt.md).
// Real runtime, fake engines: a member's and an owner's first turn echo the system prompt and the whole MCP tool list
// (names, descriptions, schemas), compared with files recorded from dev before the API engine change. Only the clock in
// the time line is replaced. A deliberate change to these paths updates the files: PIN_RECORD=1 bun test <this file>.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(90_000)
const DIR = path.join(import.meta.dir, '..', 'fixtures', 'engine-prompt-pin')
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
/** the clock (the time line's local and ISO time) is the only part that differs from run to run */
const stable = (s: string) => s
  .replace(/Now: [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M \(([^)]+)\); \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z UTC\./g, 'Now: <local time> ($1); <iso time> UTC.')
/** what this computer can do changes two parts, the same on dev and on this branch: whether a headless browser prints
 * HTML and decks to PDF (make_file's words, the instructions' make_file line) and whether a promo video can be saved as
 * an MP4 (save_promo_video, only on a development Mac). Both are held the same on every computer: no browser, and
 * save_promo_video left out of the recorded list (review on #181: the macOS recording differed from Linux CI there) */
const HOST_ONLY_TOOLS = new Set(['save_promo_video'])
const browserBefore = process.env.MYCEL_HTML_PDF_BROWSER
let h: Harness
const sockets: Record<string, TestSocket> = {}

beforeAll(async () => {
  process.env.MYCEL_HTML_PDF_BROWSER = 'none'
  h = await startHarness({ name: 'engine-prompt-pin' })
  for (const u of ['alice', 'dana']) { sockets[u] = await h.ws(u, { windowId: `win-pin-${u}` }); await sockets[u]!.next('hello') }
})
afterAll(async () => {
  for (const s of Object.values(sockets)) s.close()
  await h?.close()
  if (browserBefore === undefined) delete process.env.MYCEL_HTML_PDF_BROWSER
  else process.env.MYCEL_HTML_PDF_BROWSER = browserBefore
})

async function echo(user: string, engine: 'claude-code' | 'codex', what: 'system' | 'toolSchemas'): Promise<string> {
  const chat = await h.api(user).call(API.createChat, { body: { engine } })
  const { done } = await ask(h, sockets[user]!, user, chat.id, fake({ echo: what }))
  expect(done.status).toBe('done')
  const text = String(done.content)
  if (what === 'toolSchemas') return JSON.stringify((JSON.parse(text) as { name: string }[]).filter((t) => !HOST_ONLY_TOOLS.has(t.name)))
  return stable(text)
}

for (const engine of ['claude-code', 'codex'] as const) for (const user of ['alice', 'dana']) for (const what of ['system', 'toolSchemas'] as const) {
  test(`${engine}, ${user === 'alice' ? 'member' : 'owner'}: the ${what === 'system' ? 'instructions' : 'tool list'} stay byte for byte`, async () => {
    const got = await echo(user, engine, what)
    const file = path.join(DIR, `${engine}-${user}-${what}.txt`)
    if (process.env.PIN_RECORD === '1') fs.writeFileSync(file, got)
    expect(got.length).toBeGreaterThan(1_000)
    expect(got).toBe(fs.readFileSync(file, 'utf8'))
  })
}
