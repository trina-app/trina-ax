// Folder sharing's web part (docs/AGENTS/plan/20261116-1330-folder-share-web.md; QA TC-4077..4089): every state of the
// one Share dialog for a folder (what it holds, why it can't be shared for each reason, Paused + Resume, the saves line,
// the Everyone line, the people through a folder above with no ✕, Stop sharing only with people on it and its question
// naming nested files AND folders, Undo after a removal), the pure words (holds, people, what stays shared), which of my
// folders are offered at all. Folder sharing is always on (its rollout gate was removed, owner 2026-11-17).
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { offersFolderShare, SHARE_KEPT_NAMES } from '@mycel/shared'
import type { FileShares, Me } from '@mycel/shared/api'
import { FileShareDialog } from '../../src/components/FileShareDialog'
import { FolderAccessChip } from '../../src/components/FolderAccess'
import { blockedKey, holdsText, keptText, peopleText } from '../../src/components/FolderShareParts'
import { EveryoneLine } from '../../src/components/ShareEveryone'
import { FolderShareNotice } from '../../src/pages/admin/FolderShareNotice'
import { DialogHost } from '../../src/components/ui'
import { translate, useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const en = (k: Parameters<typeof translate>[1], p: Record<string, string | number> = {}) => translate('en', k, p)
const t = en as never as Parameters<typeof holdsText>[0]
const PATH = 'users/bob/Work'
const meWith = (o: { role?: 'member' | 'admin' } = {}) => ({
  user: { id: 'bob', username: 'bob', name: 'Bob', email: null, role: o.role ?? 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14 },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self' },
}) as unknown as Me
const OLGA = { subjectType: 'user' as const, subjectId: 'olga', name: 'Olga' }
const DANA = { subjectType: 'user' as const, subjectId: 'dana', name: 'Dana' }
const base = (o: Partial<FileShares> = {}): FileShares => ({
  path: PATH, link: null, canShare: true, owner: { id: 'bob', name: 'Bob' }, mine: true, teamFile: false, people: [],
  kind: 'folder', holds: { files: 2, folders: 1, more: false }, ...o,
})

let answer: FileShares = base()
const calls: { method: string; url: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, url, body })
    const json = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('/api/files/shares/undo')) return json({ ...answer, people: [OLGA], restored: 1, skipped: 0 })
    if (url.startsWith('/api/files/shares')) {
      if (method === 'PUT' && body?.stop) return json({ ...answer, people: [], undo: { id: 'u'.repeat(22), until: new Date(Date.now() + 600_000).toISOString() } })
      if (method === 'PUT' && body?.resume) return json({ ...answer, paused: undefined })
      return json(answer)
    }
    if (url.startsWith('/api/people')) return json({ people: [] })
    if (url.startsWith('/api/groups')) return json({ groups: [] })
    return json({})
  }) as unknown as typeof fetch
})
beforeEach(() => {
  calls.length = 0
  answer = base()
  useLocaleStore.setState({ locale: 'en' })
  useUi.setState({ toasts: [] } as never)
  useSession.setState({ status: { kind: 'signed-in', me: meWith() } } as never)
})
afterEach(() => useSession.setState({ status }))
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
})

async function dialog() {
  const m = await mount(<MemoryRouter><FileShareDialog path={PATH} onClose={() => {}} /><DialogHost /></MemoryRouter>)
  await m.until(() => m.find('file-share-people') ?? m.find('file-share-blocked'), 'the dialog read')
  return m
}

test('the words: what a folder holds, who loses it, what stays shared on its own, every reason it cannot be shared', () => {
  expect(holdsText(t, { files: 2, folders: 1, more: false })).toBe('2 files, 1 folder')
  expect(holdsText(t, { files: 1, folders: 0, more: false })).toBe('1 file')
  expect(holdsText(t, { files: 0, folders: 0, more: false })).toBe('Empty folder')
  expect(holdsText(t, { files: 480, folders: 20, more: true })).toBe('More than 500 items')
  expect(peopleText(t, [OLGA])).toBe('Olga')
  expect(peopleText(t, [OLGA, DANA])).toBe('Olga and Dana')
  expect(peopleText(t, [OLGA, DANA, { name: 'Eve' }])).toBe('Olga and 2 others')
  expect(keptText(t, 'en', { files: 2, folders: 1, people: 2, names: [{ name: 'Quote.pdf', folder: false }, { name: 'Budget.xlsx', folder: false }, { name: 'Q4', folder: true }] })).toBe('Quote.pdf, Budget.xlsx, and the folder Q4')
  expect(keptText(t, 'en', { files: 7, folders: 0, people: 1, names: [1, 2, 3, 4, 5].map((n) => ({ name: `${n}.md`, folder: false })) })).toBe('1.md, 2.md, 3.md, 4.md, 5.md, and 2 more')
  for (const b of ['root', 'system_place', 'project', 'team_folder', 'disk', 'run_active'] as const) {
    const s = en(blockedKey(b) as never)
    expect(s).not.toBe(blockedKey(b))
    // never a path
    expect(s).not.toContain('users/')
    for (const l of ['ko', 'ja', 'zh', 'es', 'id'] as const) expect(translate(l, blockedKey(b) as never)).not.toBe(s)
  }
})

test('which of my folders are offered: never the personal folder itself, a place Trina keeps (any case or width), a hidden one, or someone else\'s', () => {
  expect(offersFolderShare('users/bob/Work', 'bob')).toBe(true)
  expect(offersFolderShare('users/bob/Work/Q4', 'bob')).toBe(true)
  expect(offersFolderShare('users/bob', 'bob')).toBe(false)
  expect(offersFolderShare('users/olga/Work', 'bob')).toBe(false)
  expect(offersFolderShare('marketing', 'bob')).toBe(false)
  for (const n of SHARE_KEPT_NAMES) {
    expect(offersFolderShare(`users/bob/${n}`, 'bob')).toBe(false)
    expect(offersFolderShare(`users/bob/${n}/inside`, 'bob')).toBe(false)
  }
  expect(offersFolderShare('users/bob/Downloads', 'bob')).toBe(false)
  expect(offersFolderShare('users/bob/ｄｏｗｎｌｏａｄｓ', 'bob')).toBe(false)
  expect(offersFolderShare('users/bob/Work/.git', 'bob')).toBe(false)
})

test('a folder never shared: what it holds and that later files follow; no Stop sharing; Copy link', async () => {
  const m = await dialog()
  try {
    expect(m.get('file-share-dialog').getAttribute('data-kind')).toBe('folder')
    expect(m.get('file-share-holds').textContent).toBe(`2 files, 1 folder · ${en('fileShare.folderLater')}`)
    expect(m.find('file-share-stop')).toBeNull()
    expect(m.find('file-share-copy-link')).not.toBeNull()
    expect(m.find('file-share-picker-search')).not.toBeNull()
    expect(m.find('file-share-wide-saves')).toBeNull()
    expect(m.find('file-share-paused')).toBeNull()
  } finally {
    await m.unmount()
  }
})

test('each reason it cannot be shared: one line, no picker, no link, no Stop', async () => {
  for (const b of ['root', 'system_place', 'project', 'disk', 'run_active'] as const) {
    answer = base({ blocked: b, canShare: false })
    const m = await dialog()
    try {
      expect(m.get('file-share-blocked').textContent).toBe(en(blockedKey(b) as never))
      expect(m.find('file-share-picker-search')).toBeNull()
      expect(m.find('file-share-copy-link')).toBeNull()
      expect(m.find('file-share-stop')).toBeNull()
      expect(m.find('file-share-why')).toBeNull()
    } finally {
      await m.unmount()
    }
  }
})

test('shared: the rows with ✕, Stop sharing stops at once (no question) naming files and folders that stay shared, then Undo puts them back', async () => {
  answer = base({ people: [OLGA], ownShares: { files: 1, folders: 1, people: 1, names: [{ name: 'Plan.md', folder: false }, { name: 'Q4', folder: true }] } })
  const m = await dialog()
  try {
    expect(m.find('file-share-remove-user-olga')).not.toBeNull()
    await m.click('file-share-stop')
    expect(document.body.querySelector('[role="alertdialog"], [data-testid="dialog-confirm"]')).toBeNull()
    await m.until(() => calls.some((c) => c.method === 'PUT' && (c.body as { stop?: boolean })?.stop === true), 'the stop')
    const toast = await m.until(() => useUi.getState().toasts.at(-1), 'the toast')
    expect(toast.text).toBe(`${en('fileShare.stopped', { name: 'Work' })} ${en('fileShare.stopKeeps', { names: 'Plan.md and the folder Q4' })}`)
    expect(toast.action?.label).toBe(en('common.undo'))
    await m.until(() => !m.find('file-share-row-user-olga'), 'Olga gone')
    toast.action!.run()
    await m.until(() => calls.some((c) => c.url.startsWith('/api/files/shares/undo') && (c.body as { id: string }).id === 'u'.repeat(22)), 'the undo')
    await m.until(() => m.find('file-share-row-user-olga'), 'Olga back')
  } finally {
    await m.unmount()
  }
})

test('paused: the line and Resume, no picker; the owner can still take people off', async () => {
  answer = base({ people: [OLGA], paused: true })
  const m = await dialog()
  try {
    expect(m.get('file-share-paused').textContent).toContain(en('fileShare.paused'))
    expect(m.find('file-share-picker-search')).toBeNull()
    expect(m.find('file-share-remove-user-olga')).not.toBeNull()
    await m.click('file-share-resume')
    await m.until(() => calls.some((c) => c.method === 'PUT' && (c.body as { resume?: boolean })?.resume === true), 'the resume')
    await m.until(() => !m.find('file-share-paused') && m.find('file-share-picker-search'), 'resumed')
  } finally {
    await m.unmount()
  }
})

test('the team switch off: no picker, the folder words, but the owner still has ✕ and Stop sharing', async () => {
  answer = base({ people: [OLGA], canShare: false, off: true })
  const m = await dialog()
  try {
    expect(m.get('file-share-why').textContent).toBe(en('fileShare.offFolder'))
    expect(m.find('file-share-picker-search')).toBeNull()
    expect(m.find('file-share-remove-user-olga')).not.toBeNull()
    expect(m.find('file-share-stop')).not.toBeNull()
  } finally {
    await m.unmount()
  }
})

test('saves without asking: the line; a file inside a shared folder lists the folder\'s people "through Work" with no ✕', async () => {
  answer = base({ wideSavesOn: true })
  const a = await dialog()
  try {
    expect(a.get('file-share-wide-saves').textContent).toBe(en('fileShare.wideSaves'))
  } finally {
    await a.unmount()
  }
  answer = { ...base({ path: `${PATH}/Plan.md`, through: [{ path: PATH, name: 'Work', people: [OLGA] }] }), kind: undefined, holds: undefined }
  const m = await mount(<MemoryRouter><FileShareDialog path={`${PATH}/Plan.md`} onClose={() => {}} /><DialogHost /></MemoryRouter>)
  try {
    const row = await m.until(() => m.find('file-share-through-user-olga'), 'the row through Work')
    expect(row.textContent).toContain(en('fileShare.through', { folder: 'Work' }))
    expect(m.find('file-share-remove-user-olga')).toBeNull()
    expect(m.find('file-share-stop')).toBeNull()
    expect(m.find('file-share-holds')).toBeNull()
  } finally {
    await m.unmount()
  }
})

test('Everyone on the team: a folder has its own sentence', async () => {
  const pick = [{ subjectType: 'group' as const, subjectId: '*' }]
  const m = await mount(<><EveryoneLine picks={pick} folder testId="f" /><EveryoneLine picks={pick} testId="g" /></>)
  try {
    expect(m.get('f').textContent).toBe(en('fileShare.everyoneLineFolder'))
    expect(m.get('g').textContent).toBe(en('fileShare.everyoneLineOne'))
  } finally {
    await m.unmount()
  }
})

test('my shared folder\'s chip says Shared with whom (no Me.server.folderShares needed); an admin reads the one-time line', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: meWith({ role: 'admin' }) } } as never)
  const m = await mount(<MemoryRouter><FolderAccessChip path={PATH} access="write" project={null} onOpen={() => {}} own={{ shared: true, through: 'Work', paused: false, people: [OLGA, DANA] }} /><FolderShareNotice /></MemoryRouter>)
  try {
    const chip = m.get('folder-access-chip')
    expect(chip.getAttribute('data-kind')).toBe('shared')
    expect(chip.getAttribute('aria-label')).toBe(en('folderAccess.sharedWith', { people: 'Olga and Dana' }))
    expect(m.get('admin-folder-share-notice').textContent).toContain(en('adminHome.folderShareNotice'))
  } finally {
    await m.unmount()
  }
})
