// The demo people's past chats (docs/DECISIONS.md "Demo company: a new hire at 트리나", round 2): each history recording
// (scripts/demo/trina/recordings, record.ts) is sent again as its person in a new chat on the demo server, which replays
// it at once (server/src/demo/replay.ts): its files are made again by the product's tools in that person's folders, and
// the chat then says it was `daysAgo` days ago. Oldest first, so the sidebar lists the latest on top. A chat whose
// title is already there is not made again (the seed can run again).
import fs from 'node:fs'
import path from 'node:path'
import { API, ApiClient, DemoRecording } from '../../../shared/src/api'
import { TEAM_TOOL_PREFIX } from '../../../shared/src/product'
import { DEMO_PASSWORD } from '../seed'
import { runPrompt } from './chat-run'

export function readRecordings(dir: string): DemoRecording[] {
  let names: string[] = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch {}
  return names.flatMap((n) => {
    const r = DemoRecording.safeParse(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
    return r.success ? [r.data] : []
  })
}

/** the title the recorded answer gave its chat (set_title), if it did */
export function recordedTitle(r: DemoRecording): string | null {
  for (const e of r.events) {
    if (e.type === 'tool' && e.name === `${TEAM_TOOL_PREFIX}set_title`) {
      const t = (e.input as { title?: unknown } | null)?.title
      if (typeof t === 'string' && t.trim()) return t.trim()
    }
  }
  return null
}

export async function seedHistory(o: { baseUrl: string; dir: string; fetch?: typeof fetch; log?: (s: string) => void }): Promise<{ made: number; kept: number; failed: number }> {
  const log = o.log ?? (() => {})
  const history = readRecordings(o.dir).filter((r) => r.kind === 'history').sort((a, b) => (b.daysAgo ?? 0) - (a.daysAgo ?? 0))
  const clients = new Map<string, ApiClient>()
  const as = async (username: string) => {
    let c = clients.get(username)
    if (!c) {
      const r = await new ApiClient({ baseUrl: o.baseUrl, fetch: o.fetch }).call(API.login, { body: { username, password: DEMO_PASSWORD, client: 'web', tokenMode: 'bearer' } })
      c = new ApiClient({ baseUrl: o.baseUrl, fetch: o.fetch, token: r.token! })
      clients.set(username, c)
    }
    return c
  }
  let made = 0, kept = 0, failed = 0
  for (const r of history) {
    const api = await as(r.username)
    const title = recordedTitle(r)
    const titles = new Set((await api.call(API.listChats, { query: { limit: 200 } })).items.map((c) => c.title))
    if (title && titles.has(title)) { kept++; continue }
    try {
      const done = await runPrompt(api, r.prompt, { timeoutMs: 5 * 60_000, pollMs: 400, log })
      if (done.message.status !== 'done') throw new Error(`ended ${done.message.status}`)
      made++
      log(`past chat of ${r.username}: ${title ?? r.prompt.slice(0, 40)}`)
    } catch (e) {
      failed++
      log(`past chat of ${r.username} not made (${e instanceof Error ? e.message : String(e)}): ${r.prompt.slice(0, 40)}`)
    }
  }
  for (const c of clients.values()) await c.call(API.logout).catch(() => {})
  return { made, kept, failed }
}
