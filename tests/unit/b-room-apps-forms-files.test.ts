// Google Forms file-upload answers (QA TC-2803): Apps Script's getResponse() gives a file upload's Drive file IDs.
// The script (shared/src/api/room-apps.ts roomAppFormsScript) sends how many files instead, without asking for Drive
// access, and the server shows "N files", also for IDs a script copied before this still sends.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { roomAppFormsScript } from '@mycel/shared/api'
import { formsAnswer } from '../../server/src/rooms/apps/parse'
import { appText } from '../../server/src/rooms/apps/text'
import { harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness | undefined
afterEach(async () => { await h?.close(); h = undefined })

const ID1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'
const ID2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa987654'

/** Runs the script's sendToTrina with a fake Apps Script and returns what it posts. */
function runScript(items: { title: string; type: string; response: unknown }[]) {
  const sent: { url: string; body: any }[] = []
  const FormApp = {
    ItemType: { FILE_UPLOAD: 'FILE_UPLOAD', TEXT: 'TEXT', CHECKBOX: 'CHECKBOX' },
    getActiveForm: () => ({ getTitle: () => 'Job application' }),
  }
  const UrlFetchApp = { fetch: (url: string, o: { payload: string }) => { sent.push({ url, body: JSON.parse(o.payload) }) } }
  const DriveApp = { getFileById: () => { throw new Error('the script must not use DriveApp') } }
  const run = new Function('FormApp', 'UrlFetchApp', 'ScriptApp', 'DriveApp', 'e', `${roomAppFormsScript('https://team.example/in/x', false)}\nsendToTrina(e)`)
  const response = {
    getId: () => 'r1', getTimestamp: () => new Date('2026-11-15T01:00:00Z'), getRespondentEmail: () => '',
    getItemResponses: () => items.map((i) => ({ getItem: () => ({ getTitle: () => i.title, getType: () => i.type }), getResponse: () => i.response })),
  }
  run(FormApp, UrlFetchApp, {}, DriveApp, { response })
  return sent
}

test('the script sends how many files for a file upload, never the Drive IDs, and asks for no Drive access', () => {
  const script = roomAppFormsScript('https://team.example/in/x', true)
  expect(script).toContain('FormApp.ItemType.FILE_UPLOAD')
  expect(script).not.toContain('DriveApp')
  const [s] = runScript([
    { title: 'Name', type: 'TEXT', response: 'Mina Kim' },
    { title: 'CV', type: 'FILE_UPLOAD', response: [ID1, ID2] },
    { title: 'Days', type: 'CHECKBOX', response: ['Mon', 'Tue'] },
  ])
  expect(s!.body.answers).toEqual([{ q: 'Name', a: 'Mina Kim' }, { q: 'CV', a: '', files: 2 }, { q: 'Days', a: 'Mon, Tue' }])
  expect(JSON.stringify(s!.body)).not.toContain(ID1)
})

test('the server shows a file upload as "N files": the new count, and Drive IDs from a script copied before', () => {
  expect(formsAnswer({ q: 'CV', a: '', files: 1 }, 'en')).toBe('1 file')
  expect(formsAnswer({ q: 'CV', a: '', files: 3 }, 'en')).toBe('3 files')
  expect(formsAnswer({ q: 'CV', a: '', files: 2 }, 'ko')).toBe(appText('formsFilesN', 'ko', { n: 2 }))
  // nonsense counts show nothing
  for (const files of [0, -1, 1.5, 5000]) expect(formsAnswer({ q: 'CV', a: '', files }, 'en')).toBe('')
  // an older script: the IDs joined with ", "
  expect(formsAnswer({ q: 'CV', a: ID1 }, 'en')).toBe('1 file')
  expect(formsAnswer({ q: 'CV', a: `${ID1}, ${ID2}` }, 'en')).toBe('2 files')
  // ordinary answers stay as they were given
  for (const a of ['Mina Kim', 'Mon, Tue', 'ORDER-2026-11-15-ABCDEFGHIJ', 'supercalifragilisticexpialidocious', `${ID1}, Mon`, 'line one\nline two'])
    expect(formsAnswer({ q: 'x', a }, 'en')).toBe(a.replace(/\n+/g, ' / '))
})

test('a Google Forms card shows "N files" for a file upload, from the new script and an older one', async () => {
  h = await harness('b-room-apps-forms-files', { publicOrigins: ['https://team.acme-corp.com'] })
  const owner = await withOwner(h)
  const all = ((await owner.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'all')!.id as string
  const r = await owner.call('POST', `/api/rooms/${all}/apps`, { kind: 'google_forms' })
  const token = (r.address as string).split('/in/')[1]!
  const post = (body: unknown) => h!.fetch(`/in/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await post({ form: 'Job application', id: 'r1', at: '2026-11-15T01:00:00Z', answers: [{ q: 'Name', a: 'Mina' }, { q: 'CV', a: '', files: 2 }] })).status).toBe(200)
  expect((await post({ form: 'Job application', id: 'r2', at: '2026-11-15T02:00:00Z', answers: [{ q: 'Name', a: 'Jun' }, { q: 'CV', a: `${ID1}, ${ID2}` }] })).status).toBe(200)
  await new Promise((res) => setTimeout(res, 5))
  const ms = ((await owner.call('GET', `/api/rooms/${all}/messages`)).items as any[]).filter((m) => !m.event)
  expect(ms).toHaveLength(2)
  const files = `CV: ${appText('formsFilesN', 'ko', { n: 2 })}`
  for (const m of ms) {
    expect(m.appCard.details).toContain(files)
    expect(m.body).toContain(files)
    expect(JSON.stringify(m)).not.toContain(ID1)
  }
})
