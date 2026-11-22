// Copy link in the Share dialogs (docs/decisions/20261116-chat-share-copy-link.md, QA TC-3933;
// components/ShareCopyLink.tsx): one button with the file dialog's words, the line while people are picked and not saved
// (it names the save button), a project's copy with who opens it (a personal project: only me until it is shared). The
// address is the team address when there is one, not the page's (the desktop app on the office network is at
// 192.168.x.x), for a chat, a project and a file; an address on this computer only says so in the toast of a copy from
// a Share dialog, not as a fixed line. A copy the browser refuses says so with the link, never "Link copied". From inside the Share dialog a private chat's toast offers
// no second share flow. The words exist in every language and say the same thing.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { Chat, type Me, type Project } from '@mycel/shared/api'
import { ShareCopyLink, projectLink, useCopyProjectLink } from '../../src/components/ShareCopyLink'
import { useCopyChatLink } from '../../src/components/chat/copyChatLink'
import { fileLinkHref, useCopyTeamFileLink } from '../../src/components/FileShareDialog'
import { translate, useLocaleStore } from '../../src/i18n'
import { useProjects } from '../../src/store/projects'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

// the page as the desktop app on the office network opens it; the team's own address is another one
const PAGE = 'http://192.168.0.5:47820'
const TEAM = 'https://acme.trina.app'
const ID = '01900000-0000-7000-8000-0000000000p1'
const CHAT = '01900000-0000-7000-8000-0000000000c1'
const PROJECT = '01900000-0000-7000-8000-000000000001'
const meWith = (address: string | null) => ({
  user: { id: 'alex', username: 'alex', name: 'Alex', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14, ...(address ? { address } : {}) },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
}) as unknown as Me
const privateChat = Chat.parse({
  id: CHAT, projectId: PROJECT, title: 'Launch plan', engine: 'claude-code', model: null,
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', deletedAt: null, runState: 'idle',
})

const copied: string[] = []
let refuse = false
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const realFetch = globalThis.fetch
const status = useSession.getState().status
const locale = useLocaleStore.getState().locale
let origin = PAGE
beforeAll(() => {
  installDom()
  Object.defineProperty(globalThis, 'location', { configurable: true, get: () => ({ origin }) })
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: "abc123abc123abc123abc1", url: "/f/abc123" }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
beforeEach(() => {
  copied.length = 0
  refuse = false
  origin = PAGE
  useUi.setState({ toasts: [] } as never)
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me: meWith(TEAM) } } as never)
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { ...globalThis.navigator, clipboard: { writeText: async (s: string) => { if (refuse) throw new Error('denied'); copied.push(s) } } } })
  // the fallback copy command is refused too when the clipboard is
  ;(document as unknown as { execCommand: () => boolean }).execCommand = () => !refuse
})
afterEach(() => {
  useSession.setState({ status })
  useLocaleStore.setState({ locale })
  useProjects.setState({ byId: {} } as never)
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
})
afterAll(() => {
  globalThis.fetch = realFetch
  delete (globalThis as Record<string, unknown>).location
  removeDom()
})

setDefaultTimeout(30_000)
const lastToast = () => useUi.getState().toasts.at(-1)

test('the words: the button is the file dialog\'s "Copy link", the unsaved line names the button, in every language', () => {
  expect(translate('en', 'share.linkAfterSave', { button: 'Share' })).toBe('People you add can open the link after you press Share.')
  expect(translate('ko', 'share.linkAfterSave', { button: '공유' })).toBe('공유 버튼을 누르면 추가한 사람도 링크를 열 수 있어요.')
  for (const l of ['es', 'id', 'ja', 'zh'] as const) {
    const s = translate(l, 'share.linkAfterSave', { button: 'XYZ' })
    expect(s).toContain('XYZ')
    expect(s).not.toBe(translate('en', 'share.linkAfterSave', { button: 'XYZ' }))
  }
})

test('the button, and the line only while people are picked and not saved', async () => {
  let n = 0
  const m = await mount(<ShareCopyLink onCopy={() => void n++} testId="x-copy" />)
  try {
    expect(m.get('x-copy').textContent?.trim()).toBe('Copy link')
    expect(m.container.querySelector('[data-testid="x-copy-unsaved"]')).toBeNull()
    expect(m.container.querySelector('[data-testid="local-link-note"]')).toBeNull()
    await m.click('x-copy')
    expect(n).toBe(1)
  } finally {
    await m.unmount()
  }
  const u = await mount(<ShareCopyLink onCopy={() => {}} unsaved="Save" testId="x-copy" />)
  try {
    expect(u.get('x-copy-unsaved').textContent).toBe('People you add can open the link after you press Save.')
  } finally {
    await u.unmount()
  }
})

test('a link on this computer only (127.0.0.1, no team address): no fixed note in the dialog; the copy\'s toast says it (QA TC-ask1-14)', async () => {
  origin = 'http://127.0.0.1:47820'
  useSession.setState({ status: { kind: 'signed-in', me: meWith(null) } } as never)
  const m = await mount(<ShareCopyLink onCopy={() => {}} testId="x-copy" />)
  try {
    expect(m.container.querySelector('[data-testid="local-link-note"]')).toBeNull()
  } finally {
    await m.unmount()
  }
  const path = [translate('en', 'admin.title'), translate('en', 'admin.system'), translate('en', 'system.connection')].join(' › ')
  const note = translate('en', 'links.thisComputerOnly', { path })
  // from a Share dialog: chat, project, file
  useUi.setState({ toasts: [] } as never)
  await press((h) => h.chat({ id: CHAT }, { inDialog: true }))
  expect(lastToast()?.detail).toBe(note)
  useUi.setState({ toasts: [] } as never)
  await press((h) => h.project({ id: ID, folderPath: 'projects/launch' }))
  expect(lastToast()?.text).toBe(translate('en', 'fileLink.copied'))
  expect(lastToast()?.detail).toBe(note)
  useUi.setState({ toasts: [] } as never)
  await press((h) => h.fileInDialog('projects/launch/plan.md'))
  expect(lastToast()?.detail).toBe(note)
  // a menu's Copy link (not a Share dialog): no note
  useUi.setState({ toasts: [] } as never)
  await press((h) => h.chat({ id: CHAT }))
  expect(lastToast()?.detail).toBeUndefined()
  useUi.setState({ toasts: [] } as never)
  await press((h) => h.file('projects/launch/plan.md'))
  expect(lastToast()?.detail).toBeUndefined()
  // the team address: no note anywhere
  origin = PAGE
  useSession.setState({ status: { kind: 'signed-in', me: meWith(TEAM) } } as never)
  useUi.setState({ toasts: [] } as never)
  await press((h) => h.chat({ id: CHAT }, { inDialog: true }))
  expect(lastToast()?.detail).toBeUndefined()
  useUi.setState({ toasts: [] } as never)
  await press((h) => h.project({ id: ID, folderPath: 'projects/launch' }))
  expect(lastToast()?.detail).toBeUndefined()
})

function Probe({ run }: { run: (h: { project: ReturnType<typeof useCopyProjectLink>; chat: ReturnType<typeof useCopyChatLink>; file: ReturnType<typeof useCopyTeamFileLink>; fileInDialog: ReturnType<typeof useCopyTeamFileLink> }) => Promise<unknown> }) {
  const h = { project: useCopyProjectLink(), chat: useCopyChatLink(), file: useCopyTeamFileLink(), fileInDialog: useCopyTeamFileLink({ inDialog: true }) }
  return <button type="button" data-testid="probe" onClick={() => void run(h)}>copy</button>
}
async function press(run: Parameters<typeof Probe>[0]['run'], wait = true) {
  const m = await mount(<Probe run={run} />)
  const before = useUi.getState().toasts.length
  try {
    await m.click('probe')
    // done once it said something (copied or not)
    if (wait) await m.until(() => useUi.getState().toasts.length > before, 'the toast')
    await m.settle(50)
  } finally {
    await m.unmount()
  }
}

for (const [folderPath, words] of [['projects/launch', 'fileLink.copied'], ['users/alex/notes', 'fileLink.copiedOnlyYou']] as const) {
  test(`a project's Copy link (${folderPath}): its page's address on the team address, and who opens it`, async () => {
    await press((h) => h.project({ id: ID, folderPath }))
    expect(copied).toEqual([`${TEAM}/projects/${ID}`])
    expect(projectLink(ID, TEAM)).toBe(`${TEAM}/projects/${ID}`)
    expect(lastToast()?.text).toBe(translate('en', words))
  })
}

test('the team address differs from the page: chat, project and file links are all made on the team address', async () => {
  await press((h) => h.chat({ id: CHAT }))
  await press((h) => h.project({ id: ID, folderPath: 'projects/launch' }))
  await press((h) => h.file('projects/launch/plan.md'))
  expect(copied).toEqual([`${TEAM}/c/${CHAT}`, `${TEAM}/projects/${ID}`, `${TEAM}/f/abc123`])
  expect(copied.some((c) => c.startsWith(PAGE))).toBe(false)
  // no team address: the page's own
  useSession.setState({ status: { kind: 'signed-in', me: meWith(null) } } as never)
  copied.length = 0
  await press((h) => h.chat({ id: CHAT }))
  expect(copied).toEqual([`${PAGE}/c/${CHAT}`])
  expect(await fileLinkHref('x', TEAM)).toBe(`${TEAM}/f/abc123`)
})

test('a refused clipboard: no "Link copied", an error with the link to copy by hand (chat, project, file)', async () => {
  refuse = true
  for (const [run, href] of [
    [(h: Parameters<Parameters<typeof Probe>[0]['run']>[0]) => h.chat({ id: CHAT }), `${TEAM}/c/${CHAT}`],
    [(h: Parameters<Parameters<typeof Probe>[0]['run']>[0]) => h.project({ id: ID, folderPath: 'projects/launch' }), `${TEAM}/projects/${ID}`],
    [(h: Parameters<Parameters<typeof Probe>[0]['run']>[0]) => h.file('projects/launch/plan.md'), `${TEAM}/f/abc123`],
  ] as const) {
    useUi.setState({ toasts: [] } as never)
    await press(run)
    expect(copied).toEqual([])
    const toasts = useUi.getState().toasts
    expect(toasts.map((x) => x.level)).toEqual(['error'])
    expect(toasts[0]!.text).toBe(translate('en', 'roomApps.copyFailed'))
    expect(toasts[0]!.detail).toBe(href)
  }
})

test('a private chat in a team project: from the Share dialog the toast offers no second share flow; from a menu it does', async () => {
  useProjects.setState({ byId: { [PROJECT]: { id: PROJECT, folderPath: 'projects/launch', inTrash: false } as Project } } as never)
  await press((h) => h.chat(privateChat, { inDialog: true }))
  expect(lastToast()?.text).toBe(translate('en', 'chat.linkCopiedOnlyMe'))
  expect(lastToast()?.action).toBeUndefined()
  await press((h) => h.chat(privateChat))
  expect(lastToast()?.action?.label).toBe(translate('en', 'chat.linkShareAction'))
})
