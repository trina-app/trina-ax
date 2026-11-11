// Which AI answered (components/chat/Messages.tsx AnsweredBy): no model id under an answer; only the people who choose
// the AI get its plain name, on a small info button (docs/DECISIONS.md "Plain words for members").
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { AssistantMessage, answeredByName } from '../../src/components/chat/Messages'
import { useEngines } from '../../src/store/engines'
import { useSession } from '../../src/store/session'
import { useLocaleStore } from '../../src/i18n'
import { CHAT, msg } from './fixtures'
import { installDom, mount, removeDom } from './dom-host'

const me = (role: 'owner' | 'admin' | 'member', canChooseEngine?: boolean): Me => ({
  user: { id: 'mina', username: 'mina', name: '김민아', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {}, ...(canChooseEngine === undefined ? {} : { canChooseEngine }) },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me)

const MODELS = { 'claude-code': [{ id: 'sonnet', label: 'Claude Sonnet' }, { id: 'opus', label: 'Claude Opus' }], codex: [{ id: 'gpt-5-codex', label: 'GPT-5-Codex' }], api: [{ id: 'llama-4', label: 'Company AI' }] }

describe('answeredByName', () => {
  test('the plain name from the list, the AI when the model is unknown, the raw id only as the last resort', () => {
    expect(answeredByName({ engine: 'claude-code', model: 'sonnet' }, MODELS)).toBe('Claude Sonnet')
    // a full id the AI reported, under its alias
    expect(answeredByName({ engine: 'claude-code', model: 'claude-opus-4-1-20250805' }, MODELS)).toBe('Claude Opus')
    // a list label without the AI's name (a gateway's, the test server's "Sonnet") gets it in front
    expect(answeredByName({ engine: 'claude-code', model: 'claude-sonnet' }, { 'claude-code': [{ id: 'claude-sonnet', label: 'Sonnet' }] })).toBe('Claude Sonnet')
    // a gateway's model has no display name (its label is its id): said once
    expect(answeredByName({ engine: 'claude-code', model: 'claude-sonnet-4-5' }, { 'claude-code': [{ id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' }] })).toBe('claude-sonnet-4-5')
    expect(answeredByName({ engine: 'codex', model: 'gpt-5-codex' }, MODELS)).toBe('GPT-5-Codex')
    // the AI's own name when the model is unknown: ChatGPT, as in Settings › AI accounts
    expect(answeredByName({ engine: 'codex', model: 'new-model' }, MODELS)).toBe('ChatGPT')
    expect(answeredByName({ engine: 'api', model: 'llama-4' }, MODELS)).toBe('Company AI')
    expect(answeredByName({ engine: 'claude-code', model: 'something-new' }, MODELS)).toBe('Claude')
    expect(answeredByName({ engine: 'claude-code', model: null }, {})).toBe('Claude')
    expect(answeredByName({ engine: null, model: 'x-1' }, {})).toBe('x-1')
    expect(answeredByName({ engine: null, model: null }, {})).toBeNull()
  })
})

describe('the answer footer', () => {
  const before = { status: useSession.getState().status, locale: useLocaleStore.getState().locale, engines: useEngines.getState() }
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
    // loaded already: the footer does not ask the server
    useEngines.setState({ loaded: true, canChoose: true, engines: ['claude-code'], models: MODELS })
  })
  afterAll(() => {
    useSession.setState({ status: before.status })
    useLocaleStore.setState({ locale: before.locale })
    useEngines.setState(before.engines)
    removeDom()
  })
  const render = async (who: Me) => {
    useSession.setState({ status: { kind: 'signed-in', me: who } } as never)
    const m = msg({ role: 'assistant', content: '안녕하세요', engine: 'claude-code', model: 'claude-sonnet-4-5-20250929' })
    const page = await mount(
      <MemoryRouter>
        <AssistantMessage m={m} chatId={CHAT} isLast busy={false} switchedFrom={null} onRegenerate={() => {}} onSelectBranch={() => {}} onAskOwnFolder={() => {}} />
      </MemoryRouter>,
    )
    const html = page.html()
    const button = page.find('answer-model')
    const label = button?.getAttribute('aria-label') ?? null
    await page.unmount()
    return { html, label }
  }

  test('a member sees no model at all', async () => {
    const r = await render(me('member'))
    expect(r.label).toBeNull()
    expect(r.html).not.toContain('claude-sonnet')
    expect(r.html).not.toContain('Claude Sonnet')
  })

  test('the owner, an admin and a member allowed to choose get the plain name, never the raw id', async () => {
    for (const who of [me('owner'), me('admin'), me('member', true)]) {
      const r = await render(who)
      expect(r.label).toBe('답한 AI: Claude Sonnet')
      expect(r.html).not.toContain('claude-sonnet-4-5')
    }
    // an admin the owner did not let choose
    expect((await render(me('admin', false))).label).toBeNull()
  })
})
