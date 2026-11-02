// The real team server for desktop/e2e/pc-chain.spec.ts: every route module, the real web app (web/dist), the real launcher, gate and
// bridge, with the fake engine in place of the model (tests/lib/b-fake-engine.ts). Prints one JSON line when it is ready.
import { API, uuidv7 } from '@mycel/shared/api'
import { startHarness, testSessions } from './b-harness'
import { newPcConsent, savePcSetting } from '../../server/src/pc/setting'

process.env.MYCEL_PC_RUNNER = '1'
// the one person of this test, in the desktop app: the app sends no test headers, and the web app starts from /api/me,
// which reads the sessions table
const SESSION_ID = uuidv7()
/** the owner: in no group of the fixture, whose ids the contract of /api/me would refuse */
const PERSON = 'dana'
const resolve = testSessions.resolve.bind(testSessions)
testSessions.resolve = async (req, info) => {
  const headers = new Headers(req.headers)
  if (!headers.has('x-test-user')) {
    headers.set('x-test-user', PERSON)
    headers.set('x-test-client', 'desktop')
  }
  const a = await resolve(new Request(req.url, { headers }), info)
  return a ? { ...a, session: { ...a.session, id: SESSION_ID } } : a
}
const h = await startHarness({ name: 'pc-chain', askUserTimeoutMs: 60_000, turnTimeoutMs: 120_000 })
const project = await h.api(PERSON).call(API.createProject, { body: { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' } })
savePcSetting(h.ctx.db, project.id, { enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, consent: newPcConsent({ id: 'carol', name: 'Carol Park' }) })
const chat = await h.api(PERSON).call(API.createChat, { body: { projectId: project.id } })
const row: Record<string, unknown> = { id: SESSION_ID, user_id: PERSON, client: 'desktop', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400_000).toISOString() }
const columns = (h.ctx.db.query('PRAGMA table_info(sessions)').all() as { name: string; notnull: number; dflt_value: unknown }[])
for (const c of columns) if (c.notnull && c.dflt_value === null && !(c.name in row)) row[c.name] = c.name.includes('_at') ? new Date().toISOString() : `pc-chain-${c.name}`
h.ctx.db.query(`INSERT INTO sessions (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...(Object.values(row) as string[]))
console.log(JSON.stringify({ port: h.server.port, chatId: chat.id, projectId: project.id }))
process.on('SIGTERM', () => void h.close().finally(() => process.exit(0)))
