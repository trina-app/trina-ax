// Admin › AI providers › an account › ⋯ › Check again (pages/admin/Credentials.tsx, docs/decisions/
// 20261125-ai-account-refusal-recheck.md): the menu closes on the click, so the row's own badge turns and says
// "Checking…" while it runs; then one toast says what the provider answered: connected (success), still refused with why
// and a Reconnect / Replace action, or no clear answer (try again shortly). The provider's answer of a refused account
// is in its opened row.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type Credential, type Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { ProviderAccounts, useTeamCredentials } from '../../src/pages/admin/Credentials'
import { resetAdminReads } from '../../src/store/adminPeople'
import { installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const me = { user: { id: 'owner', username: 'owner', name: 'Owner', email: null, role: 'owner', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2030-01-01T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const ID = uuidv7()
const cred = (o: Partial<Credential> = {}): Credential => ({
  id: ID, kind: 'anthropic-oauth', label: 'Claude Max', scope: 'team', owner: null, assignments: [], priority: 10, disabled: false,
  state: 'invalid', detail: '지금은 이 Claude 계정의 플랜이나 조직이 접속을 허용하지 않아요.', hint: null, planType: null,
  expiresAt: null, limitedUntil: null, checkedAt: null, lastUsedAt: null, spendLimit: { usd: null, tokens: null, action: 'warn' },
  month: { usd: 0, tokens: 0, requests: 0 }, createdAt: '2026-11-01T00:00:00.000Z',
  providerError: { status: 403, type: 'permission_error', message: 'OAuth authentication is currently not allowed for this organization.', at: '2026-11-25T01:00:00.000Z' },
  ...o,
})
/** the next answer to Check again, released by the test */
let checkAnswer: { body: unknown; code?: number } = { body: {} }
let release: (() => void) | null = null
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    if (key === 'GET /api/admin/credentials') return json({ items: [cred()], memberOwn: false, sharedSubscriptions: true, allowedKinds: ['anthropic-oauth'], pricesAsOf: '2026-11-01' })
    if (key === 'GET /api/admin/users' || key === 'GET /api/admin/groups') return json({ items: [] })
    if (key === `POST /api/admin/credentials/${ID}/check`) {
      await new Promise<void>((r) => { release = r })
      return json(checkAnswer.body, checkAnswer.code)
    }
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => { useSession.setState({ status }); resetAdminReads(); useUi.setState({ toasts: [] }); release = null })
afterAll(() => { globalThis.fetch = realFetch; removeDom(); useLocaleStore.setState({ locale }) })

function Page() {
  const tc = useTeamCredentials()
  return <>{tc.dialogs}<ProviderAccounts tc={tc} fam="claude" /></>
}

async function checkAgain(answer: typeof checkAnswer) {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  checkAnswer = answer
  const m = await mount(<MemoryRouter><Page /></MemoryRouter>)
  await m.until(() => m.find('credential-menu'), 'the row')
  await m.click('credential-menu')
  await m.click('credential-check')
  // the menu is gone; the row's badge says it is checking
  await m.until(() => release, 'the check request')
  expect(m.find('credential-check')).toBeNull()
  expect(m.get('credential-state').getAttribute('data-checking')).toBe('')
  expect(m.get('credential-state').textContent).toContain('확인 중…')
  release!()
  await m.until(() => useUi.getState().toasts.length > 0, 'the toast')
  expect(m.get('credential-state').getAttribute('data-checking')).toBeNull()
  return { m, toast: useUi.getState().toasts[0]! }
}

test('connected: a green toast that says so, and the row shows Working', async () => {
  const { m, toast } = await checkAgain({ body: { ...cred({ state: 'ok', detail: null, providerError: null }), check: { outcome: 'ok', reason: null } } })
  try {
    expect(toast).toMatchObject({ level: 'success', text: '연결됐어요. 공급자가 받아 줬어요.' })
    expect(m.get('credential-state').textContent).toBe('정상')
  } finally { await m.unmount() }
})

test('still refused: a red toast with the provider\'s reason and Reconnect, which opens the reconnect dialog', async () => {
  const reason = 'permission_error: OAuth authentication is currently not allowed for this organization.'
  const { m, toast } = await checkAgain({ body: { ...cred(), check: { outcome: 'refused', reason } } })
  try {
    expect(toast).toMatchObject({ level: 'error', text: `여전히 거절됨: ${reason}` })
    expect(toast.action?.label).toBe('다시 연결하기')
    expect(m.get('credential-state').textContent).toBe('거절됨')
    // the opened row shows what the provider answered, as text
    await m.click('credential-open')
    expect(m.get('credential-provider-answer').textContent).toContain('403 · permission_error · OAuth authentication is currently not allowed for this organization.')
  } finally { await m.unmount() }
})

test('no clear answer: "try again shortly", with what the provider said as the second line; nothing else changes', async () => {
  const { m, toast } = await checkAgain({ body: { ...cred(), check: { outcome: 'unclear', reason: 'HTTP 503' } } })
  try {
    expect(toast).toMatchObject({ level: 'warn', text: '확인 못 함: 잠시 후 다시 해 주세요.', detail: 'HTTP 503' })
    expect(toast.action).toBeUndefined()
  } finally { await m.unmount() }
})
