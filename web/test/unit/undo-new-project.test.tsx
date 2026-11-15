// 되돌리기 after a chat's ⋯ › 프로젝트로 옮기기 › + 새 프로젝트 (components/chat/ChatProject.tsx undoMadeAndMove,
// docs/DECISIONS.md "Making a project"): the chat goes back, then the project made in that step is deleted only while
// it is still as it was made (DELETE /api/projects/:id?ifEmpty=1; the server decides). Kept (409), it stays without a
// word; a refused move back leaves the project alone.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { Chat, type Me, type Project } from '@mycel/shared/api'
import { undoMadeAndMove } from '../../src/components/chat/ChatProject'
import { useLocaleStore } from '../../src/i18n'
import { resetOptimistic } from '../../src/lib/optimistic'
import { useChats } from '../../src/store/chats'
import { useProjects } from '../../src/store/projects'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, removeDom } from './dom-host'
import { ME } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ID = '01900000-0000-7000-8000-0000000000c3'
const MADE = '01900000-0000-7000-8000-0000000000d7'
const me = {
  user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const chat = (o: Partial<Chat> = {}) => Chat.parse({
  id: ID, projectId: null, title: 'Acme board summary', engine: 'claude-code', model: null,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle', ...o,
})
const made = { id: MADE, name: 'Acme board summary', folderPath: `users/${ME.id}/projects/Acme board summary`, instructions: '', createdBy: { id: ME.id, name: ME.name }, createdAt: '2026-11-13T00:00:00.000Z', canEdit: true } as unknown as Project
const json = (body: unknown, code = 200) => new Response(code === 204 ? null : JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })

/** every request, and the answer the test gives each by "METHOD path" */
const asked: { method: string; url: string; body: unknown }[] = []
let answers: Record<string, () => Response> = {}
const toasts = () => (useUi.getState() as unknown as { toasts: { level: string; text: string }[] }).toasts

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    asked.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const a = answers[`${method} ${url.split('?')[0]}`]
    return a ? a() : json({ error: { code: 'not_found', message: 'nope' } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => {
  asked.length = 0
  answers = {}
  resetOptimistic()
  useChats.getState().reset()
  useProjects.getState().reset()
  useUi.setState({ toasts: [] } as never)
})
afterAll(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status })
  useLocaleStore.setState({ locale })
  removeDom()
})

const setup = () => {
  const inIt = chat({ projectId: MADE })
  useChats.setState({ chats: [inIt], chatsLoaded: true })
  useProjects.getState().see(made)
  return inIt
}

test('undo: the chat goes back, then the project made in that step is deleted with ifEmpty and leaves the lists', async () => {
  const inIt = setup()
  answers[`PATCH /api/chats/${ID}`] = () => json(chat({ projectId: null, updatedAt: '2026-11-13T00:00:01.000Z' }))
  answers[`DELETE /api/projects/${MADE}`] = () => json(null, 204)
  await undoMadeAndMove(inIt, null, MADE)
  expect(asked.map((a) => `${a.method} ${a.url.split('?')[0]}`)).toEqual([`PATCH /api/chats/${ID}`, `DELETE /api/projects/${MADE}`])
  expect(asked[0]!.body).toEqual({ projectId: null })
  expect(new URL(asked[1]!.url, 'http://x').searchParams.get('ifEmpty')).toBe('1')
  expect(useChats.getState().chats.find((c) => c.id === ID)?.projectId).toBeNull()
  expect(useProjects.getState().byId[MADE]).toBeUndefined()
  expect(toasts().filter((t) => t.level === 'error')).toEqual([])
})

test('undo: a project that is no longer empty (409) stays, without an error toast', async () => {
  const inIt = setup()
  answers[`PATCH /api/chats/${ID}`] = () => json(chat({ projectId: null, updatedAt: '2026-11-13T00:00:01.000Z' }))
  answers[`DELETE /api/projects/${MADE}`] = () => json({ error: { code: 'conflict', message: 'kept', params: { reason: 'project_not_empty' } } }, 409)
  await undoMadeAndMove(inIt, null, MADE)
  expect(useChats.getState().chats.find((c) => c.id === ID)?.projectId).toBeNull()
  expect(useProjects.getState().byId[MADE]?.id).toBe(MADE)
  expect(toasts().filter((t) => t.level === 'error')).toEqual([])
})

test('undo: when the chat cannot go back, the project is not touched', async () => {
  const inIt = setup()
  answers[`PATCH /api/chats/${ID}`] = () => json({ error: { code: 'internal', message: 'Acme server down' } }, 500)
  await undoMadeAndMove(inIt, null, MADE)
  expect(asked.some((a) => a.method === 'DELETE')).toBe(false)
  expect(useChats.getState().chats.find((c) => c.id === ID)?.projectId).toBe(MADE)
  expect(useProjects.getState().byId[MADE]?.id).toBe(MADE)
})
