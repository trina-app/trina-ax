// A failed answer's words by who reads it (lib/chatErrors.ts, docs/DECISIONS.md "Plain words in errors, cards and
// steps"): everyone reads what happened and who to tell, never an engine, a proxy, an API or an HTTP code; the owner and
// admins read where to fix it, in the admin menu's own words; the server's health page only for the owner, who alone
// sees it. A connection's sign-in failure is said in words, never as its stored code.
import { expect, test } from 'bun:test'
import { CHAT_ERROR_MESSAGES, type ChatErrorReason } from '@mycel/shared/api'
import { translate, type MessageKey } from '../../src/i18n'
import { adminPath, chatErrorText } from '../../src/lib/chatErrors'
import { flowReasonKey } from '../../src/lib/integrations'

const LOCALES = ['ko', 'en', 'id', 'ja', 'es'] as const
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
  for (const r of ['auth', 'no_credential', 'credential_unusable', 'model_not_found', 'endpoint_unreachable', 'lockdown', 'trial_credit_used', 'trial_ended'] as const) {
    for (const role of ['owner', 'admin'] as const) {
      expect([r, role, say('en', r, role)]).toEqual([r, role, translate('en', `chat.error.admin.${r}` as MessageKey, { path: providers })])
      expect(say('en', r, role)).toContain(providers)
    }
  }
  for (const r of ['engine_missing', 'proxy_down'] as const) {
    expect(say('en', r, 'owner')).toContain(health)
    // an admin cannot open the health page: the member's words ("let the team owner know")
    expect(say('en', r, 'admin')).toBe(CHAT_ERROR_MESSAGES[r].en)
  }
  // nothing to fix in the admin menu: the same words for everyone
  for (const r of ['rate_limit', 'context', 'timeout', 'wall_timeout', 'refused', 'crash', 'interrupted', 'user_disabled', 'output_limit', 'provider_error'] as const) {
    expect(say('en', r, 'owner')).toBe(CHAT_ERROR_MESSAGES[r].en)
  }
  // every language names the same menu in its own words, and none keeps an engine or an HTTP code
  for (const l of LOCALES) {
    const t = (k: MessageKey) => translate(l, k)
    expect(say(l, 'no_credential', 'admin')).toContain(adminPath(t, 'providers'))
    expect(say(l, 'engine_missing', 'owner')).toContain(adminPath(t, 'health'))
    // a full server disk (QA TC-209): the owner and admins are pointed at Admin › System, where the storage card is
    expect(say(l, 'storage_full', 'owner')).toContain(adminPath(t, 'system'))
    expect(say(l, 'storage_full', 'admin')).toContain(adminPath(t, 'system'))
    for (const r of REASONS) expect([l, r, JARGON.test(say(l, r, 'owner'))]).toEqual([l, r, false])
  }
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
