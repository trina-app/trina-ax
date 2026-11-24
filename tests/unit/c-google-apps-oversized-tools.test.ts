// A Google app connection reads the library's list of all four apps' tools and keeps its own app's (catalog.ts
// appTools). A tool of another app that is too large to keep (mcp.ts shrinkSchema) is not this connection's: it never
// sets toolsTooLarge here nor shows in its log line; one of its own app's does. Fake Google and a fake library only.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, PEOPLE, type CApp } from '../lib/c-app'
import { APP_CLIENT, FakeGoogle, FakeLibrary, sessionRow } from '../lib/fake-google-apps'
import { googleAppsOf } from '../../server/src/integrations/google-apps/service'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { getRow, view } from '../../server/src/integrations/connections/store'

setDefaultTimeout(60_000)

let A: CApp, lib: FakeLibrary, gmail = ''
const logged: { msg: string; fields?: Record<string, unknown> }[] = []
/** a schema whose structure alone is over the cap (no description to cut) */
const huge = () => ({ type: 'object', properties: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`field_number_${i}`, { type: 'string' }])) })
let big: string | null = null

beforeAll(async () => {
  lib = new FakeLibrary().start()
  const tools = lib.tools.bind(lib)
  lib.tools = () => tools().map((t: any) => (t.name === big ? { ...t, inputSchema: huge() } : t))
  process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url
  A = await makeCApp('gapps-oversized')
  ;(A.ctx.config as any).tunnel = { host: 'team.example.test' }
  const warn = A.ctx.log.warn.bind(A.ctx.log)
  A.ctx.log.warn = (msg, fields) => { logged.push({ msg, fields }); warn(msg, fields) }
  const google = new FakeGoogle(lib)
  const apps = googleAppsOf(A.ctx, { fetch: google.fetch })
  for (const p of PEOPLE) sessionRow(A.ctx.db, p)
  expect((await A.json('/api/admin/google-apps/gmail/client', { method: 'PUT', as: 'carol', headers: { 'content-type': 'application/json' }, body: JSON.stringify(APP_CLIENT) })).status).toBe(200)
  const f = await apps.authorize('alice', 'alice-session', 'gmail')
  expect(await apps.callback(google.authorize(f.authorizationUrl, 'alice'), { userId: 'alice', sessionId: 'alice-session' })).toBe(true)
  expect((await apps.complete('alice', 'alice-session', 'gmail', f.flowId)).status).toBe('connected')
  gmail = (A.ctx.db.query("SELECT id FROM integrations WHERE owner_user_id='alice' AND google_app='gmail'").get() as { id: string }).id
})
afterAll(async () => { await A?.close(); lib?.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })

const check = async () => { const svc = integrationsOf(A.ctx); const row = await svc.check(getRow(A.ctx.db, gmail)!); return { body: view(A.ctx.db, row, { id: 'alice', role: 'member' } as any, 'en') as any } }
const sizeLines = () => logged.filter((l) => l.msg.includes('schema size limit') && l.fields?.id === gmail)

test("another app's oversized tool: not this connection's (no toolsTooLarge, no log line)", async () => {
  big = 'get_events'
  logged.length = 0
  const r = await check()
  expect(r.body.status).toBe('connected')
  expect(r.body.tools.length).toBeGreaterThan(0)
  expect(r.body.toolsTooLarge).toBeUndefined()
  expect(sizeLines()).toEqual([])
})

test("its own app's oversized tool: counted and logged", async () => {
  big = 'list_gmail_labels'
  logged.length = 0
  const r = await check()
  expect(r.body.tools.map((t: any) => t.name)).not.toContain('list_gmail_labels')
  expect(r.body.toolsTooLarge).toBe(1)
  expect(sizeLines()[0]!.fields).toMatchObject({ dropped: 1, droppedTools: [expect.stringMatching(/^list_gmail_labels \(/)] })
  big = null
})
