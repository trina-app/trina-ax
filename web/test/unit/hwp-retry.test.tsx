// A Hangul preview that failed offers [다시 시도] only where asking again can help (QA TC-265 FILES-23). With no HWP
// renderer on the server (/api/files/hwp-preview → 503 {reason:'engine'}) the panel said "이 서버에서는 한글 미리보기를
// 쓸 수 없어요. 원본을 내려받아 주세요." and still showed [다시 시도]: now only the download. A timeout, a busy queue and a
// request that never got the server's answer keep it. The same viewer draws a room file's pages (FileBody), so the
// room's file viewer behaves the same.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Me } from '@mycel/shared/api'
import { HwpReason } from '@mycel/shared/hwp'
import HwpView, { hwpCanRetry } from '../../src/components/viewers/HwpView'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const me = {
  user: { id: 'mina', username: 'mina', name: '김민아', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
/** what the server answers to every page asked for; 'network': no answer at all */
let answer: Response | 'network' = json({})
const asked: string[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const statusBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(new URL(String(input), 'http://x').pathname)
    if (answer === 'network') throw new TypeError('Failed to fetch')
    return answer.clone()
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: statusBefore })
})
beforeEach(() => {
  asked.length = 0
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
})
const refused = (reason: string) => json({ error: { code: 'unavailable', message: reason, params: { reason } } }, 503)
const text = (m: { get(id: string): { textContent: string | null } }) => m.get('preview-unsupported').textContent ?? ''

describe('the panel of a failed Hangul preview', () => {
  for (const source of [{ kind: 'team', path: 'shared/Docs/plan.hwp' }, { kind: 'room', roomId: 'r1', fileId: 'f1' }] as const) {
    test(`${source.kind}: no renderer on this server (503 engine): the download, no [다시 시도]`, async () => {
      answer = refused('engine')
      const m = await mount(<HwpView source={source} download={() => {}} />)
      try {
        await m.until(() => !!m.find('preview-unsupported'), 'the notice')
        expect(text(m)).toContain('이 서버에서는 한글 미리보기를 쓸 수 없어요. 원본을 내려받아 주세요.')
        expect(m.find('preview-unsupported-download')).not.toBeNull()
        expect(m.find('preview-unsupported-retry')).toBeNull()
        expect(text(m)).not.toContain('다시 시도')
        expect(asked[0]).toBe(source.kind === 'team' ? '/api/files/hwp-preview' : '/api/rooms/r1/files/f1/hwp-preview')
      } finally {
        await m.unmount()
      }
    })
  }

  test('a timeout: the download and [다시 시도], which asks again', async () => {
    answer = refused('timeout')
    const m = await mount(<HwpView source={{ kind: 'team', path: 'shared/Docs/plan.hwp' }} download={() => {}} />)
    try {
      await m.until(() => !!m.find('preview-unsupported-retry'), 'the retry')
      expect(m.find('preview-unsupported-download')).not.toBeNull()
      const before = asked.length
      await m.click('preview-unsupported-retry')
      await m.until(() => asked.length > before, 'asked again')
    } finally {
      await m.unmount()
    }
  })

  test('no answer from the server (the connection): [다시 시도] stays', async () => {
    answer = 'network'
    const m = await mount(<HwpView source={{ kind: 'team', path: 'shared/Docs/plan.hwp' }} download={() => {}} />)
    try {
      await m.until(() => !!m.find('preview-unsupported'), 'the notice')
      expect(m.find('preview-unsupported-retry')).not.toBeNull()
      expect(m.find('preview-unsupported-download')).not.toBeNull()
    } finally {
      await m.unmount()
    }
  })
})

test('which reasons offer [다시 시도]', () => {
  const retry = HwpReason.options.filter(r => hwpCanRetry(r, true))
  expect(retry).toEqual(['disabled', 'timeout', 'cancelled', 'busy', 'changed'])
  // not the server's words (a failure without its answer, shown as 'engine'): it may pass
  for (const r of HwpReason.options) expect(hwpCanRetry(r, false)).toBe(true)
  expect(hwpCanRetry('missing', true)).toBe(true)
  expect(hwpCanRetry('quarantined', true)).toBe(false)
})
