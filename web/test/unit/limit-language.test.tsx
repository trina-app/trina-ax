// A member's answer stopped by a used-up usage limit (error budget_exceeded) reads in the language the app shows now,
// not the one it stopped in (QA AP-077: stopped in Korean, still Korean after switching to English). The words are the
// server's own (shared limitUsedUpText, server/src/admin/budgets.ts budgetBlock).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { limitResetText, limitUsedUpText } from '@mycel/shared'
import { AssistantMessage } from '../../src/components/chat/Messages'
import { useEngines } from '../../src/store/engines'
import { useSession } from '../../src/store/session'
import { useLocaleStore } from '../../src/i18n'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const me: Me = {
  user: { id: 'mina', username: 'mina', name: '김민아', email: null, role: 'member', locale: 'en', localeChoice: 'en', mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted', timeZone: 'Asia/Seoul' },
} as unknown as Me

const KO = '이번 달 AI 사용 한도를 다 썼어요. 12월 1일 0시부터 다시 쓸 수 있어요. 더 필요하면 관리자에게 말해 주세요.'
const RESETS = '2026-11-30T15:00:00.000Z'

describe('a used-up limit in the language of the app', () => {
  const before = { status: useSession.getState().status, locale: useLocaleStore.getState().locale, engines: useEngines.getState() }
  beforeAll(() => {
    installDom()
    useEngines.setState({ loaded: true, canChoose: false, engines: ['claude-code'], models: {} })
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
  })
  afterAll(() => {
    useSession.setState({ status: before.status })
    useLocaleStore.setState({ locale: before.locale })
    useEngines.setState(before.engines)
    removeDom()
  })
  const text = async (params: Record<string, string | boolean>) => {
    const m = msg({ role: 'assistant', content: 'Part one.', status: 'error', error: { code: 'budget_exceeded', message: KO, params } })
    const page = await mount(
      <MemoryRouter>
        <AssistantMessage m={m} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} />
      </MemoryRouter>,
    )
    const html = page.html()
    await page.unmount()
    return html
  }

  test('stopped in Korean, read in English: English words, the team time zone\'s date', async () => {
    useLocaleStore.setState({ locale: 'en' })
    const html = await text({ resetsAt: RESETS, period: 'month', own: true })
    expect(html).toContain('You have used up this month')
    expect(html).toContain('AI usage limit. You can use it again from Dec 1 at 00:00. Ask an admin if you need more.')
    expect(html).not.toContain('한도')
  })

  test('the same words the server says, in every language', () => {
    expect(limitUsedUpText({ locale: 'ko', period: 'month', at: limitResetText(new Date(RESETS), 'ko', 'Asia/Seoul'), who: 'member' })).toBe(KO)
    expect(limitUsedUpText({ locale: 'en', period: 'day', at: 'X', who: 'member' })).toBe("You have used up today's AI usage limit. You can use it again from X. Ask an admin if you need more.")
  })

  test('one stored before the server sent its period keeps its words', async () => {
    useLocaleStore.setState({ locale: 'en' })
    const html = await text({ resetsAt: RESETS, own: true })
    expect(html).toContain(KO)
  })
})
