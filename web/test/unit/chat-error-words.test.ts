// A failed answer's words by who reads it (lib/chatErrors.ts, docs/DECISIONS.md "Plain words in errors, cards and
// steps"): everyone reads what happened and who to tell, never an engine, a proxy, an API or an HTTP code; the owner and
// admins read where to fix it, in the admin menu's own words; the server's health page only for the owner, who alone
// sees it. A connection's sign-in failure is said in words, never as its stored code.
import { describe, expect, test } from 'bun:test'
import { CHAT_ERROR_MESSAGES, chatErrorReason, DEMO_LIMIT_REASON, DEMO_REST_REASON, type ChatErrorReason } from '@mycel/shared/api'
import { translate, type MessageKey } from '../../src/i18n'
import { adminPath, chatErrorText, usageLimitOf, usageLimitText } from '../../src/lib/chatErrors'
import { flowReasonKey } from '../../src/lib/integrations'

const LOCALES = ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const
const REASONS = Object.keys(CHAT_ERROR_MESSAGES) as ChatErrorReason[]
const say = (l: (typeof LOCALES)[number], r: ChatErrorReason, role: 'owner' | 'admin' | 'member', noAi = false) => {
  const { key, where } = chatErrorText(r, role, noAi)
  return translate(l, key, where ? { path: adminPath((k: MessageKey) => translate(l, k), where) } : undefined)
}
// developer words a member must never read (any language); "AI" itself is fine
const JARGON = /\b(engine|proxy|API|HTTP|endpoint)\b|엔진|프록시|モデルプロキシ|エンジン|mesin AI|motor de IA|\(HTTP/i

test('a member reads what happened and who to tell, with no engine, proxy, API, HTTP code or admin menu', () => {
  for (const l of LOCALES) for (const r of REASONS) {
    const text = say(l, r, 'member')
    expect([l, r, text]).toEqual([l, r, CHAT_ERROR_MESSAGES[r][l]])
    expect([l, r, JARGON.test(text)]).toEqual([l, r, false])
    expect(text).not.toContain('›')
    expect(text).not.toContain('{path}')
  }
})

test('the owner and admins read where to fix it, in the menu\'s own words; the health page only for the owner', () => {
  const providers = `${translate('en', 'admin.title')} › ${translate('en', 'admin.providers')}`
  const health = `${translate('en', 'admin.title')} › ${translate('en', 'admin.system')} › ${translate('en', 'system.health')}`
  for (const r of ['auth', 'no_credential', 'credential_unusable', 'model_not_found', 'endpoint_unreachable', 'lockdown'] as const) {
    for (const role of ['owner', 'admin'] as const) {
      expect([r, role, say('en', r, role)]).toEqual([r, role, translate('en', `chat.error.admin.${r}` as MessageKey, { path: providers })])
      expect(say('en', r, role)).toContain(providers)
    }
  }
  expect(say('en', 'proxy_down', 'owner')).toContain(health)
  // an admin cannot open the health page: the member's words ("let the team owner know")
  expect(say('en', 'proxy_down', 'admin')).toBe(CHAT_ERROR_MESSAGES.proxy_down.en)
  // nothing to fix in the admin menu: the same words for everyone
  for (const r of ['rate_limit', 'context', 'timeout', 'wall_timeout', 'stalled', 'refused', 'crash', 'interrupted', 'user_disabled', 'output_limit', 'provider_error'] as const) {
    expect(say('en', r, 'owner')).toBe(CHAT_ERROR_MESSAGES[r].en)
  }
  // every language names the same menu in its own words, and none keeps an engine or an HTTP code
  for (const l of LOCALES) {
    const t = (k: MessageKey) => translate(l, k)
    expect(say(l, 'no_credential', 'admin')).toContain(adminPath(t, 'providers'))
    expect(say(l, 'proxy_down', 'owner')).toContain(adminPath(t, 'health'))
    // a full server disk (QA TC-209): the owner and admins are pointed at Admin › System, where the storage card is
    expect(say(l, 'storage_full', 'owner')).toContain(adminPath(t, 'system'))
    expect(say(l, 'storage_full', 'admin')).toContain(adminPath(t, 'system'))
    // the engine firewall is off on the server (QA TC-310): the owner is pointed at the health page's firewall line,
    // an admin (who cannot open it) reads the member's words
    expect(say(l, 'network_protection_off', 'owner')).toContain(adminPath(t, 'health'))
    expect(say(l, 'network_protection_off', 'admin')).toBe(CHAT_ERROR_MESSAGES.network_protection_off[l])
    // the AI could not start on the server (QA TC-3521): the owner and admins read that trying again won't help and who
    // fixes it, with no menu path (the health page does not show it); a member reads that the admins were told
    for (const role of ['owner', 'admin'] as const) {
      expect(say(l, 'engine_start_failed', role)).toBe(translate(l, 'chat.error.admin.engine_start_failed'))
      expect(say(l, 'engine_start_failed', role)).not.toContain('›')
    }
    for (const r of REASONS) expect([l, r, JARGON.test(say(l, r, 'owner'))]).toEqual([l, r, false])
  }
})

// owner decision 2026-11-11: the AI cannot start (engine_missing). A member reads "Trina isn't ready yet." (the button
// beside it tells an admin); the owner and an admin read their own words, which the [Connect AI] button goes with, and
// no menu path or developer word in either
test('the AI cannot start: "not ready yet" for a member, "connect an AI" for the owner and an admin', () => {
  expect(say('en', 'engine_missing', 'member')).toBe("Trina isn't ready yet.")
  for (const role of ['owner', 'admin'] as const) {
    expect(chatErrorText('engine_missing', role, false)).toEqual({ key: 'chat.error.admin.engine_missing', where: null })
    expect(say('en', 'engine_missing', role)).toBe("Trina isn't ready yet. Connect an AI so it can answer.")
  }
  for (const l of LOCALES) for (const role of ['owner', 'admin', 'member'] as const) {
    const text = say(l, 'engine_missing', role)
    expect([l, role, JARGON.test(text) || /›|>|Diagnos|진단|診断|Diagnóstico|Diagnostik/.test(text)]).toEqual([l, role, false])
  }
  // AI or no AI, the same words (it is not a missing connection)
  expect(chatErrorText('engine_missing', 'member', true).key).toBe('chat.error.engine_missing')
})

test('no AI answers the owner or an admin: the words that go with the connect button, the path filled in', () => {
  expect(chatErrorText('no_credential', 'owner', true).key).toBe('aiConnect.error.no_credential')
  const unusable = say('en', 'credential_unusable', 'admin', true)
  expect(unusable).toContain(`${translate('en', 'admin.title')} › ${translate('en', 'admin.providers')}`)
  expect(unusable).not.toContain('AI connections')
  // a member keeps the member's words, AI or not
  expect(chatErrorText('no_credential', 'member', true).key).toBe('chat.error.no_credential')
})

test('a connection sign-in that did not finish is said in words, never as its stored code', () => {
  // the sign-in row keeps the words, not the code (lib/integrations.ts flowReasonKey, with #381's client reasons)
  for (const code of ['denied', 'invalid', 'changed', 'superseded', 'exchange', 'client', 'client_template']) {
    expect(flowReasonKey(code)).not.toBe('integrations.signIn.failed')
    expect(translate('ko', flowReasonKey(code))).not.toContain(code)
    for (const l of LOCALES) expect(translate(l, flowReasonKey(code))).not.toContain('integrations.')
  }
  for (const other of ['scope_denied', '', null]) expect(flowReasonKey(other)).toBe('integrations.signIn.failed')
})

test('AI usage used up until a known time: everyone reads when it comes back; the owner and admins where to add another account, a member to wait or tell an admin', () => {
  const providers = `${translate('en', 'admin.title')} › ${translate('en', 'admin.providers')}`
  const word = (role: 'owner' | 'admin' | 'member', until: boolean) => {
    const { key, where } = chatErrorText('usage_used_up', role, false, until)
    return translate('en', key, { ...(where ? { path: adminPath((k: MessageKey) => translate('en', k), where) } : {}), date: 'Nov 21, 3:00 PM' })
  }
  for (const role of ['owner', 'admin'] as const) {
    expect(word(role, true)).toContain('Nov 21, 3:00 PM')
    expect(word(role, true)).toContain(providers)
    expect(word(role, false)).toContain(providers)
  }
  expect(word('member', true)).toContain('Nov 21, 3:00 PM')
  expect(word('member', true)).toContain('let an admin know')
  expect(word('member', true)).not.toContain('›')
  // never "for now, try again a bit later" (that is the short wait's words)
  for (const l of LOCALES) for (const role of ['owner', 'member'] as const) {
    const { key } = chatErrorText('usage_used_up', role, false, true)
    const text = translate(l, key, { path: 'X', date: 'D' })
    expect([l, role, text.includes('D'), text.includes('{')]).toEqual([l, role, true, false])
    expect(text).not.toBe(CHAT_ERROR_MESSAGES.rate_limit[l])
    expect([l, JARGON.test(text)]).toEqual([l, false])
  }
})

// owner report 2026-11-25: the whole team's Claude subscription was used up (the proxy's 403 subscription_limited) and a
// member read "ask your admin to add more AI usage", which no admin can do. One place tells the cause; the words follow.
describe('a used-up AI limit: its cause, then words by cause and reader', () => {
  const until = '2026-11-28T00:37:00.000Z'
  const provider = (params: Record<string, string | number | boolean> = {}) => ({ code: 'rate_limited' as const, message: CHAT_ERROR_MESSAGES.usage_used_up.ko, params: { reason: 'usage_used_up', ...params } })
  const budget = (params: Record<string, string | number | boolean> = {}) => ({ code: 'budget_exceeded' as const, message: '이번 달 AI 사용 한도를 다 썼어요. 12월 1일 0시부터 다시 쓸 수 있어요. 더 필요하면 관리자에게 말해 주세요.', params })
  const text = (l: (typeof LOCALES)[number], role: 'owner' | 'admin' | 'member' | 'guest', withUntil: boolean) => {
    const said = usageLimitText({ cause: 'provider', until: withUntil ? until : null }, role)!
    return translate(l, said.key, { ...(said.where ? { path: adminPath((k: MessageKey) => translate(l, k), said.where) } : {}), date: 'D' })
  }

  test('the cause: a limit an admin set (budget), the AI account at its provider\'s limit (provider), or none', () => {
    expect(usageLimitOf(budget({ resetsAt: '2026-11-30T15:00:00.000Z', own: true }))).toEqual({ cause: 'budget', until: '2026-11-30T15:00:00.000Z' })
    expect(usageLimitOf(budget())).toEqual({ cause: 'budget', until: null })
    expect(usageLimitOf(provider({ until }))).toEqual({ cause: 'provider', until })
    expect(usageLimitOf(provider())).toEqual({ cause: 'provider', until: null })
    expect(usageLimitOf(provider({ until: 'not a date' }))).toEqual({ cause: 'provider', until: null })
    // an answer stored before params.reason, by its exact words, old and new
    for (const message of [CHAT_ERROR_MESSAGES.usage_used_up.en, "The AI usage has run out, so the AI can't answer right now. Ask your admin to add more AI usage."])
      expect(usageLimitOf({ code: 'rate_limited', message })).toEqual({ cause: 'provider', until: null })
    // a free-roam demo's own stop and anything else: not a used-up limit
    for (const reason of [DEMO_LIMIT_REASON, DEMO_REST_REASON]) expect(usageLimitOf({ code: 'budget_exceeded', message: 'x', params: { reason } })).toBeNull()
    expect(usageLimitOf({ code: 'rate_limited', message: CHAT_ERROR_MESSAGES.rate_limit.en, params: { reason: 'rate_limit' } })).toBeNull()
    expect(usageLimitOf({ code: 'engine_unavailable', message: 'x' })).toBeNull()
    expect(usageLimitOf(null)).toBeNull()
  })

  test('a limit an admin set: the server\'s own words stand (they say to ask an admin, who can raise it)', () => {
    for (const role of ['owner', 'admin', 'member', 'guest'] as const) expect(usageLimitText({ cause: 'budget', until: null }, role)).toBeNull()
  })

  test('the provider\'s limit, a member: when it comes back, then wait or tell an admin; never "ask to add more"', () => {
    for (const l of LOCALES) for (const withUntil of [true, false]) {
      const t = text(l, 'member', withUntil)
      expect([l, withUntil, t.includes('D')]).toEqual([l, withUntil, withUntil])
      expect([l, t.includes('›'), t.includes('{'), JARGON.test(t)]).toEqual([l, false, false, false])
    }
    expect(text('en', 'member', true)).toBe('The AI account has reached its usage limit. It can be used again from D. Until then, wait or let an admin know.')
    expect(text('ko', 'member', true)).toBe('AI 계정이 사용 한도에 도달했어요. D부터 다시 쓸 수 있어요. 그때까지 기다리거나 관리자에게 알려 주세요.')
    expect(text('en', 'member', false)).toBe(CHAT_ERROR_MESSAGES.usage_used_up.en)
    for (const l of LOCALES) for (const t of [text(l, 'member', true), text(l, 'member', false), CHAT_ERROR_MESSAGES.usage_used_up[l]])
      expect([l, /add more|늘려|増やして|añada más|menambah|增加/.test(t)]).toEqual([l, false])
  })

  test('the provider\'s limit, the owner and admins: when it comes back, and another AI account in Admin › AI providers goes on now', () => {
    for (const l of LOCALES) for (const role of ['owner', 'admin'] as const) {
      const path = `${translate(l, 'admin.title')} › ${translate(l, 'admin.providers')}`
      expect([l, role, text(l, role, true).includes(path), text(l, role, true).includes('D'), text(l, role, false).includes(path)]).toEqual([l, role, true, true, true])
    }
    expect(text('ko', 'admin', true)).toBe('AI 계정이 사용 한도에 도달했어요. D부터 다시 쓸 수 있어요. 그 전에 계속 쓰려면 관리자 › AI 제공사에서 다른 AI 계정을 연결해 주세요.')
  })

  test('the provider\'s limit, a guest: the person who invited them, never an admin they do not know', () => {
    for (const l of LOCALES) for (const withUntil of [true, false]) expect([l, text(l, 'guest', withUntil) === text(l, 'member', withUntil)]).toEqual([l, false])
    expect(text('en', 'guest', true)).toContain('the person who invited you')
    expect(text('en', 'guest', true)).not.toContain('admin')
  })

  test('the stored words of each cause are told apart by the shared reader too', () => {
    expect(chatErrorReason(provider())).toBe('usage_used_up')
    expect(chatErrorReason(budget())).toBeNull()
  })
})
