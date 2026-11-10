// A file from the computer in a shared project chat (docs/DECISIONS.md "Shared project chats": "A file from the computer
// in a shared chat"; components/chat/ComposerFiles.tsx, Composer.tsx): the box offers the computer again, the old note
// and refusal are gone, one line under the chips says the file is saved in the project folder and who sees it, and ✕ on
// such a chip says the file goes to the trash and asks the server to put it there. A chat of one person has neither.
// Someone who may not write the project folder (Project.chatUploads, Chat.shared.canUpload false) is offered team files
// only: no computer or camera in the menu, a pasted file is not taken, a dragged one gets the not-allowed cursor.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { ApiError, type Attachment, type Me } from '@mycel/shared/api'
import { DICTS, translate, useLocaleStore } from '../../src/i18n'
import Composer from '../../src/components/chat/Composer'
import { SharedUploadLine, type Pending } from '../../src/components/chat/ComposerFiles'
import { refusalKey } from '../../src/lib/sharedChat'
import { TEAM_FILE_DRAG_TYPE, writeStash } from '../../src/lib/teamAttach'
import { useSession } from '../../src/store/session'
import { CHAT } from './fixtures'
import { FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'

const me = {
  user: { id: 'olga', username: 'olga', name: 'Olga', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const LINE = (folder: string, n: number) => translate('ko', 'chat.sharedUploadLine', { folder, n })
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
const realFetch = globalThis.fetch
const calls: string[] = []

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    calls.push(key)
    if (key.startsWith('DELETE /api/attachments/')) return new Response(JSON.stringify({ trashed: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'not here' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})
afterEach(() => { calls.length = 0; localStorage.clear() })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})

const att = (o: Partial<Attachment>): Attachment => ({ id: crypto.randomUUID(), name: '견적.pdf', path: 'projects/quotation/채팅 첨부/견적.pdf', size: 1200, mime: 'application/pdf', kind: 'pdf', ...o })
const chip = (o: Partial<Pending>): Pending => ({ id: crypto.randomUUID(), source: 'upload', name: '견적.pdf', size: 1200, status: 'done', progress: null, abort: new AbortController(), ...o })

describe('the line under the chips', () => {
  const lineOf = async (files: Pending[], audience = 3) => {
    const m = await mount(<SharedUploadLine files={files} audience={audience} />)
    try { return m.find('shared-upload-line')?.textContent ?? null } finally { await m.unmount() }
  }

  test('a file from the computer: where it is saved (the folder it went to) and how many people see it there', async () => {
    expect(await lineOf([chip({ attachment: att({ source: 'team' }) })])).toBe(LINE('채팅 첨부', 3))
    expect(LINE('채팅 첨부', 3)).toBe('프로젝트 폴더(채팅 첨부)에 저장돼요 · 프로젝트 사람 3명이 볼 수 있어요')
    // a folder already there under another language's name is the one named
    expect(await lineOf([chip({ attachment: att({ source: 'team', path: 'projects/quotation/Chat attachments/견적.pdf' }) })], 5)).toBe(LINE('Chat attachments', 5))
    // still uploading: the folder the team's language names
    expect(await lineOf([chip({ status: 'uploading' })])).toBe(LINE('채팅 첨부', 3))
  })

  test('nothing for no chips, team files only, or an upload that failed', async () => {
    expect(await lineOf([])).toBeNull()
    expect(await lineOf([chip({ source: 'team', path: 'projects/quotation/견적서 양식.xlsx', attachment: att({ source: 'team', path: 'projects/quotation/견적서 양식.xlsx' }) })])).toBeNull()
    expect(await lineOf([chip({ status: 'failed', error: 'x' })])).toBeNull()
  })
})

describe('the box of a shared chat', () => {
  const open = async (draftId: string, shared: boolean, items: Pending[] = []): Promise<Mounted> => {
    writeStash('olga', draftId, items)
    return mount(
      <Composer draftId={draftId} ensureChat={async () => CHAT} running={false} onSend={async () => {}} onStop={async () => {}} engine={{ engine: undefined, model: undefined }}
        sharedUploads={shared ? { audience: 3 } : undefined} />,
    )
  }

  test('the attach menu offers the computer, with no note against it; the old refusal is nowhere', async () => {
    const m = await open('project:p1', true)
    try {
      await m.click('attach-button')
      await m.until(() => m.find('attach-team'), 'the attach menu')
      expect(m.find('attach-computer')).not.toBeNull()
      expect(m.find('attach-team-only')).toBeNull()
      expect(m.html()).not.toContain('팀 파일만')
    } finally { await m.unmount() }
    // no text of the app says so any more, in any language; the send guard's refusal keeps the server's own words
    for (const dict of Object.values(DICTS)) expect(Object.keys(dict).filter((k) => k === 'chat.sharedTeamFiles')).toEqual([])
    expect(Object.values(DICTS.ko).filter((v) => v.includes('팀 파일만 붙일 수 있어요'))).toEqual([])
    expect(refusalKey(new ApiError(409, { code: 'conflict', message: '…', params: { reason: 'shared_chat_upload' } } as never), 'chat')).toBeNull()
  })

  test('a chip saved in the project folder: the line, and ✕ says the file goes to the trash and puts it there', async () => {
    const a = att({ source: 'team' })
    const m = await open('project:p2', true, [chip({ attachment: a })])
    try {
      expect(m.get('shared-upload-line').textContent).toBe(LINE('채팅 첨부', 3))
      const label = translate('ko', 'composer.removeUploadToTrash', { name: '견적.pdf' })
      expect(label).toBe('견적.pdf 빼기 · 프로젝트 폴더에 저장된 파일은 휴지통으로 가요')
      const x = m.container.querySelector(`button[aria-label="${label}"]`)
      expect(x).not.toBeNull()
      await m.click(x!)
      await m.until(() => calls.includes(`DELETE /api/attachments/${a.id}`), 'the delete')
      expect(m.find('attachment-chip')).toBeNull()
      expect(m.find('shared-upload-line')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a team file picked from the folder: no line, and ✕ only takes it out of the box', async () => {
    const a = att({ source: 'team', path: 'projects/quotation/견적서 양식.xlsx', name: '견적서 양식.xlsx' })
    const m = await open('project:p3', true, [chip({ source: 'team', name: a.name, path: a.path, attachment: a })])
    try {
      expect(m.find('shared-upload-line')).toBeNull()
      const x = m.container.querySelector(`button[aria-label="${translate('ko', 'composer.removeAttachment', { name: a.name })}"]`)
      await m.click(x!)
      await m.settle(50)
      expect(m.find('attachment-chip')).toBeNull()
      expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([])
    } finally { await m.unmount() }
  })

  test('a chat of one person: an upload in my own folder has no line, and ✕ asks nothing of the server', async () => {
    const a = att({ path: `users/olga/.attachments/${CHAT}/견적.pdf` })
    const m = await open('new', false, [chip({ attachment: a })])
    try {
      expect(m.find('shared-upload-line')).toBeNull()
      const x = m.container.querySelector(`button[aria-label="${translate('ko', 'composer.removeAttachment', { name: '견적.pdf' })}"]`)
      await m.click(x!)
      await m.settle(50)
      expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([])
    } finally { await m.unmount() }
  })
})

describe('someone who may not write the project folder: team files only', () => {
  const open = (allowed: boolean | undefined) => mount(
    <Composer draftId={`project:ro-${String(allowed)}-${crypto.randomUUID()}`} ensureChat={async () => CHAT} running={false} onSend={async () => {}} onStop={async () => {}}
      engine={{ engine: undefined, model: undefined }} sharedUploads={{ audience: 3, ...(allowed === undefined ? {} : { allowed }) }} />,
  )
  const menu = async (m: Mounted) => {
    await m.click('attach-button')
    await m.until(() => m.find('attach-team'), 'the attach menu')
  }
  const pdf = () => new File(['%PDF-1.4'], '견적 요청서.pdf', { type: 'application/pdf' })

  test('the menu: "팀 파일에서 추가" only, no computer and no camera', async () => {
    const m = await open(false)
    try {
      await menu(m)
      expect(m.find('attach-computer')).toBeNull()
      expect(m.find('attach-camera')).toBeNull()
      expect(m.get('attach-team').textContent).toContain(translate('ko', 'composer.fromTeam'))
    } finally { await m.unmount() }
    // allowed, or not said (an older server): the computer is offered as before
    for (const allowed of [true, undefined]) {
      const n = await open(allowed)
      try {
        await menu(n)
        expect(n.find('attach-computer')).not.toBeNull()
        expect(n.find('attach-camera')).not.toBeNull()
      } finally { await n.unmount() }
    }
  })

  test('a pasted file is not taken (the paste goes on as text), and nothing is sent', async () => {
    const m = await open(false)
    try {
      const e = Object.assign(new FakeEvent('paste', { bubbles: true, cancelable: true }), { clipboardData: { files: [pdf()], items: [] } })
      m.get('composer-input').dispatchEvent(e)
      await m.settle(50)
      expect(e.defaultPrevented).toBe(false)
      expect(m.find('attachment-chip')).toBeNull()
      expect(m.find('shared-upload-line')).toBeNull()
      expect(calls.filter((c) => c.startsWith('POST'))).toEqual([])
    } finally { await m.unmount() }
  })

  test('a file dragged from the computer: the not-allowed cursor, no highlight, and a drop does nothing (nor opens it)', async () => {
    const m = await open(false)
    try {
      const box = m.get('composer')
      const dt = { types: ['Files'], files: [pdf()], dropEffect: 'copy', getData: () => '' }
      const over = Object.assign(new FakeEvent('dragover', { bubbles: true, cancelable: true }), { dataTransfer: dt })
      box.dispatchEvent(over)
      await m.settle()
      expect([over.defaultPrevented, dt.dropEffect]).toEqual([true, 'none'])
      expect(box.getAttribute('class')).not.toContain('ring-accent')
      const drop = Object.assign(new FakeEvent('drop', { bubbles: true, cancelable: true }), { dataTransfer: dt })
      box.dispatchEvent(drop)
      await m.settle(50)
      expect(drop.defaultPrevented).toBe(true)
      expect(m.find('attachment-chip')).toBeNull()
      expect(calls.filter((c) => c.startsWith('POST'))).toEqual([])
      // a team file dragged from the file screen still drops (attached by reference)
      const team = { types: [TEAM_FILE_DRAG_TYPE], files: [], dropEffect: '', getData: (t: string) => (t === TEAM_FILE_DRAG_TYPE ? 'projects/quotation/견적서 양식.xlsx' : '') }
      const teamOver = Object.assign(new FakeEvent('dragover', { bubbles: true, cancelable: true }), { dataTransfer: team })
      box.dispatchEvent(teamOver)
      await m.settle()
      expect([teamOver.defaultPrevented, team.dropEffect]).toEqual([true, 'copy'])
      box.dispatchEvent(Object.assign(new FakeEvent('drop', { bubbles: true, cancelable: true }), { dataTransfer: team }))
      await m.until(() => calls.includes('POST /api/attachments/team-file'), 'the team file attached')
    } finally { await m.unmount() }
  })

  test('allowed: the same drag is taken (copy, highlighted)', async () => {
    const m = await open(true)
    try {
      const box = m.get('composer')
      const dt = { types: ['Files'], files: [pdf()], dropEffect: '', getData: () => '' }
      const over = Object.assign(new FakeEvent('dragover', { bubbles: true, cancelable: true }), { dataTransfer: dt })
      box.dispatchEvent(over)
      await m.settle()
      expect([over.defaultPrevented, dt.dropEffect]).toEqual([true, 'copy'])
      expect(box.getAttribute('class')).toContain('ring-accent')
    } finally { await m.unmount() }
  })
})
