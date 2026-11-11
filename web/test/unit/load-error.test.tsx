// The calm notice of a place that could not be read (components/LoadError.tsx, lib/autoRetry.ts; docs/DECISIONS.md
// "How we show errors"), rendered and clicked (dom-host.ts) inside a small place that reads like the app's lists do:
// - the connection: "지금 연결이 안 돼요" with "다시 연결하는 중…" and [다시 시도], role=status, nothing red; it reads again
//   by itself and, when that works, the notice goes and the data shows without a click; a draft typed meanwhile stays;
// - [다시 시도] reads at once; a failed read keeps the notice;
// - the server's own error: the red note with its words, and no read by itself; `soft`: the calm "불러오지 못했어요";
// - while the app's connection banner shows: a quiet spinner and no words, no read; the connection back: read at once;
// - a hidden page reads nothing; shown again, it reads at once;
// - the message box: a send that fails for the connection keeps the text, says so calmly (never red) and sends it on
//   [다시 시도]; another failure keeps its red line; while its line shows, a notice on the same page (Home's block) steps
//   down to the quiet spinner, so the cause is said once.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, useCallback, useEffect, useState } from 'react'
import { ApiError } from '@mycel/shared/api'
import { translate, useLocaleStore, type MessageKey } from '../../src/i18n'
import { LoadError } from '../../src/components/LoadError'
import Composer from '../../src/components/chat/Composer'
import { forgetRetryLevels } from '../../src/lib/autoRetry'
import { useUi } from '../../src/store/ui'
import { CHAT } from './fixtures'
import { FakeEvent, installDom, mount, removeDom, type FakeElement, type Mounted } from './dom-host'

const ko = (k: MessageKey) => translate('ko', k)
const offline = () => new TypeError('Failed to fetch')
const serverError = () => new ApiError(500, { code: 'internal', message: '서버 오류가 발생했어요.' })

/** A place that reads like the app's lists: the error stays until a read works. `next` answers each read. */
let next: () => Promise<string> = async () => 'data'
let reads = 0
function Place({ soft }: { soft?: boolean }) {
  const [data, setData] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const load = useCallback(async () => {
    reads++
    try {
      setData(await next())
      setError(null)
    } catch (e) {
      setError(e)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  return (
    <>
      <textarea data-testid="draft" />
      {error ? <LoadError error={error} onRetry={load} soft={soft} what="place" /> : data && <p data-testid="data">{data}</p>}
    </>
  )
}

const before = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
})
afterAll(() => {
  removeDom()
  useLocaleStore.setState({ locale: before })
})
afterEach(() => {
  forgetRetryLevels()
  useUi.setState({ conn: 'idle' })
  ;(document as unknown as { visibilityState?: string }).visibilityState = 'visible'
  reads = 0
})

const classes = (m: Mounted) => [...m.container.querySelectorAll('[class]')].map((e) => (e as FakeElement).getAttribute('class') ?? '').join(' ')
const notice = (m: Mounted) => m.find('load-error')

describe('the connection', () => {
  test('the calm notice; it reads again by itself and the data shows without a click; the draft stays', async () => {
    let fail = true
    next = async () => { if (fail) throw offline(); return '방 목록' }
    const m = await mount(<Place />)
    try {
      await m.until(() => notice(m), 'the notice')
      const n = notice(m)!
      expect(n.getAttribute('role')).toBe('status')
      expect(n.getAttribute('data-state')).toBe('connection')
      expect(n.getAttribute('data-what')).toBe('place')
      expect(n.textContent).toContain(ko('conn.now'))
      expect(n.textContent).toContain(ko('conn.retrying'))
      expect(m.get('load-error-retry').textContent).toBe(ko('common.retry'))
      // calm: no alert, nothing red, the neutral surface
      expect(m.container.querySelector('[role="alert"]')).toBeNull()
      expect(classes(m)).not.toMatch(/danger/)
      expect(n.getAttribute('class')).toContain('bg-subtle')
      expect(n.textContent).not.toContain(ko('error.network'))
      // the person types meanwhile
      await m.type('draft', '이번 주 회의록 정리해 줘')
      // the connection is back: the next read (2 s) works
      fail = false
      await m.until(() => m.find('data'), 'the data, without a click', 4_000)
      expect(notice(m)).toBeNull()
      expect(reads).toBe(2)
      expect((m.get('draft') as unknown as { value: string }).value).toBe('이번 주 회의록 정리해 줘')
    } finally { await m.unmount() }
  }, 10_000)

  test('[다시 시도] reads at once; a failed read keeps the notice', async () => {
    let answers = [offline(), offline(), null]
    next = async () => { const a = answers.shift(); if (a) throw a; return '파일' }
    const m = await mount(<Place />)
    try {
      await m.until(() => notice(m), 'the notice')
      await m.click('load-error-retry')
      await m.settle(50)
      expect(reads).toBe(2)
      expect(notice(m)?.getAttribute('data-state')).toBe('connection')
      await m.click('load-error-retry')
      await m.until(() => m.find('data'), 'the data')
      expect(reads).toBe(3)
      answers = []
    } finally { await m.unmount() }
  })

  test('a 502–504 from the relay is the connection too', async () => {
    let fail = true
    next = async () => { if (fail) throw new ApiError(502, { code: 'unavailable', message: 'x', params: { httpStatus: 502 } }); return 'ok' }
    const m = await mount(<Place />)
    try {
      await m.until(() => notice(m), 'the notice')
      expect(notice(m)!.getAttribute('data-state')).toBe('connection')
      fail = false
      await m.click('load-error-retry')
      await m.until(() => m.find('data'), 'the data')
    } finally { await m.unmount() }
  })
})

describe('the server\'s own error', () => {
  test('the red note with its words; no read by itself', async () => {
    next = async () => { throw serverError() }
    const m = await mount(<Place />)
    try {
      await m.until(() => m.container.querySelector('[role="alert"]'), 'the error note')
      expect(m.container.textContent).toContain('서버 오류가 발생했어요.')
      expect(notice(m)).toBeNull()
      await m.settle(2_500)
      expect(reads).toBe(1)
    } finally { await m.unmount() }
  }, 10_000)

  test('soft (a part that is extra on its page): the calm "불러오지 못했어요" with [다시 시도], never red', async () => {
    let fail = true
    next = async () => { if (fail) throw serverError(); return 'ok' }
    const m = await mount(<Place soft />)
    try {
      await m.until(() => notice(m), 'the notice')
      expect(notice(m)!.getAttribute('data-state')).toBe('failed')
      expect(notice(m)!.textContent).toContain(ko('conn.loadFailed'))
      expect(notice(m)!.textContent).not.toContain(ko('conn.retrying'))
      expect(m.container.querySelector('[role="alert"]')).toBeNull()
      expect(classes(m)).not.toMatch(/danger/)
      fail = false
      await m.click('load-error-retry')
      await m.until(() => m.find('data'), 'the data')
    } finally { await m.unmount() }
  })
})

describe('the app\'s connection banner says it once', () => {
  test('while it shows: a quiet spinner, no words, no read; the connection back: read at once', async () => {
    let fail = true
    next = async () => { if (fail) throw offline(); return 'ok' }
    useUi.setState({ conn: 'reconnecting' })
    const m = await mount(<Place />)
    try {
      await m.until(() => notice(m), 'the place waiting')
      expect(notice(m)!.getAttribute('data-state')).toBe('waiting')
      expect(notice(m)!.textContent).toBe('')
      expect(m.find('load-error-retry')).toBeNull()
      await m.settle(2_500)
      expect(reads).toBe(1)
      // offline for a while (the banner's second state): still waiting
      await act(async () => useUi.setState({ conn: 'offline' }))
      await m.settle(50)
      expect(reads).toBe(1)
      fail = false
      await act(async () => useUi.setState({ conn: 'open' }))
      await m.until(() => m.find('data'), 'the data once the connection is back')
      expect(reads).toBe(2)
    } finally { await m.unmount() }
  }, 10_000)
})

describe('a hidden page', () => {
  test('reads nothing while hidden; shown again, it reads at once', async () => {
    let fail = true
    next = async () => { if (fail) throw offline(); return 'ok' }
    const m = await mount(<Place />)
    const doc = document as unknown as { visibilityState: string; dispatchEvent(e: FakeEvent): boolean }
    try {
      await m.until(() => notice(m), 'the notice')
      await act(async () => {
        doc.visibilityState = 'hidden'
        doc.dispatchEvent(new FakeEvent('visibilitychange'))
      })
      await m.settle(2_500)
      expect(reads).toBe(1)
      fail = false
      await act(async () => {
        doc.visibilityState = 'visible'
        doc.dispatchEvent(new FakeEvent('visibilitychange'))
      })
      await m.until(() => m.find('data'), 'the data once the page shows')
      expect(reads).toBe(2)
    } finally { await m.unmount() }
  }, 10_000)
})

describe('the message box', () => {
  test('a send that fails for the connection keeps the text, says so calmly and sends it on [다시 시도]', async () => {
    const sent: string[] = []
    let fail = true
    const m = await mount(<Composer draftId="calm-test" ensureChat={async () => CHAT} running={false} onSend={async (text) => { if (fail) throw offline(); sent.push(text) }} onStop={async () => {}} engine={{ engine: undefined, model: undefined }} />)
    try {
      await m.type('composer-input', '이번 주 회의록 정리해 줘')
      await m.click('send')
      await m.until(() => m.find('composer-unsent'), 'the calm line')
      const line = m.get('composer-unsent')
      expect(line.getAttribute('role')).toBe('status')
      expect(line.textContent).toContain(ko('conn.unsent'))
      expect(m.container.querySelector('[role="alert"]')).toBeNull()
      expect(classes(m)).not.toMatch(/text-danger/)
      // the text stays in the box
      expect((m.get('composer-input') as unknown as { value: string }).value).toBe('이번 주 회의록 정리해 줘')
      expect(sent).toEqual([])
      // never sent by itself
      await m.settle(2_500)
      expect(sent).toEqual([])
      fail = false
      await m.click('composer-unsent-retry')
      await m.until(() => sent.length > 0, 'sent')
      expect(sent).toEqual(['이번 주 회의록 정리해 줘'])
      await m.until(() => !m.find('composer-unsent'), 'the line gone')
    } finally { await m.unmount() }
  }, 10_000)

  test('while its line shows, a place on the same page waits quietly: the cause is said once', async () => {
    next = async () => { throw offline() }
    let fail = true
    const m = await mount(
      <>
        <Composer draftId="calm-test-3" ensureChat={async () => CHAT} running={false} onSend={async () => { if (fail) throw offline() }} onStop={async () => {}} engine={{ engine: undefined, model: undefined }} />
        <Place />
      </>,
    )
    try {
      await m.until(() => notice(m)?.getAttribute('data-state') === 'connection', 'the place\'s notice')
      await m.type('composer-input', '안녕')
      await m.click('send')
      await m.until(() => m.find('composer-unsent'), 'the message box\'s line')
      await m.until(() => notice(m)?.getAttribute('data-state') === 'waiting', 'the place waiting quietly')
      expect(notice(m)!.textContent).toBe('')
      expect(m.container.textContent).not.toContain(ko('conn.now'))
      // sent after all: the line goes, and the place says it again while it still cannot read
      fail = false
      await m.click('composer-unsent-retry')
      await m.until(() => !m.find('composer-unsent'), 'the line gone')
      await m.until(() => notice(m)?.getAttribute('data-state') === 'connection', 'the place\'s notice again')
    } finally { await m.unmount() }
  }, 10_000)

  test('another failure keeps its red line with the server\'s words', async () => {
    const m = await mount(<Composer draftId="calm-test-2" ensureChat={async () => CHAT} running={false} onSend={async () => { throw serverError() }} onStop={async () => {}} engine={{ engine: undefined, model: undefined }} />)
    try {
      await m.type('composer-input', '안녕')
      await m.click('send')
      await m.until(() => m.container.querySelector('[role="alert"]'), 'the red line')
      expect(m.container.textContent).toContain('서버 오류가 발생했어요.')
      expect(m.find('composer-unsent')).toBeNull()
    } finally { await m.unmount() }
  })
})
