// Chat errors in plain words (shared/src/api/errors.ts, server/src/chat/i18n.ts, docs/DECISIONS.md "Plain words in
// errors, cards and steps"): no engine, proxy, API or HTTP code in the text the server stores, the provider's status kept
// in params for diagnostics; errors stored with the earlier words (no params.reason) are still told apart and so follow
// the language on screen.
import { expect, test } from 'bun:test'
import { CHAT_ERROR_MESSAGES, chatErrorReason, ERROR_MESSAGES, isDefaultErrorMessage, type ChatErrorReason } from '../../shared/src/api'
import { engineError, tr } from '../../server/src/chat/i18n'

const LOCALES = ['ko', 'en', 'id', 'ja', 'es'] as const
const JARGON = /\b(engine|proxy|API|HTTP|endpoint)\b|엔진|프록시|エンジン|プロキシ|mesin AI|motor de IA|\(HTTP|관리 ›|Admin ›|Admin >|관리자 >/i

test('no engine, proxy, API, HTTP code or admin menu in any chat error, in any language', () => {
  for (const [r, text] of Object.entries(CHAT_ERROR_MESSAGES)) for (const l of LOCALES) expect([r, l, JARGON.test(text[l])]).toEqual([r, l, false])
  for (const l of LOCALES) expect(JARGON.test(ERROR_MESSAGES.engine_unavailable[l])).toBe(false)
})

test('the provider\'s HTTP status stays in params, never in the words', () => {
  const e = engineError('provider_error', 'ko', undefined, 502)
  expect(e.message).toBe(CHAT_ERROR_MESSAGES.provider_error.ko)
  expect(e.message).not.toContain('502')
  expect(e.params).toEqual({ reason: 'provider_error', status: 502 })
  expect(engineError('crash', 'en').params).toEqual({ reason: 'crash' })
})

test('an error stored with the earlier words and no reason is still told apart (all five languages)', () => {
  const old: [ChatErrorReason, string][] = [
    ['engine_missing', '지금은 AI 엔진을 쓸 수 없어요. 팀장에게 알려 주세요(관리자 > 시스템 > 진단에서 원인을 볼 수 있어요).'],
    ['proxy_down', 'The AI connection (model proxy) is not ready. Try again in a moment; if it keeps happening, let the team owner know.'],
    ['crash', 'Mesin AI berhenti tiba-tiba. Coba lagi.'],
    ['no_credential', 'このエンジン用のAI接続がありません。管理者に知らせてください。'],
    ['model_not_found', 'El servicio de IA no reconoce el modelo configurado. Pida a su administrador que revise el nombre del modelo del motor API.'],
    ['trial_credit_used', '체험 AI 크레딧을 다 썼어요. 팀장이 관리 › AI 연결에서 팀의 AI를 연결하면 이어서 쓸 수 있어요.'],
    // the 합니다체 before 0.2.16 still counts too
    ['crash', 'AI 엔진이 예기치 않게 멈췄습니다. 다시 시도해 주세요.'],
  ]
  for (const [reason, message] of old) expect(chatErrorReason({ code: CHAT_ERROR_MESSAGES[reason].code, message })).toBe(reason)
  // and the new words, as stored by this server for older clients
  for (const l of LOCALES) expect(chatErrorReason({ code: 'busy', message: CHAT_ERROR_MESSAGES.wall_timeout[l] })).toBe('wall_timeout')
  // the generic default of engine_unavailable, old and new, is a default text (shown in the language on screen)
  expect(isDefaultErrorMessage('engine_unavailable', 'The AI engine is not available right now. Let the team owner know (Admin > System > Diagnostics shows why).')).toBe(true)
  expect(isDefaultErrorMessage('engine_unavailable', ERROR_MESSAGES.engine_unavailable.ja)).toBe(true)
})

test('refusals about which AI answers and the team\'s security settings in plain words', () => {
  for (const key of ['engineChoiceNotAllowed', 'engineOff', 'sharedChatCreatorOnly', 'roomAiSafeOps', 'sharedChatSafeOps', 'sharedProjectSafeOps', 'chatShareSafeOps'] as const) {
    for (const l of LOCALES) {
      const text = tr(key, l)
      expect([key, l, /엔진|engine|mesin|エンジン|motor|안전 작업 모드|safe operations|operasi aman|安全作業モード|operaciones seguras/i.test(text)]).toEqual([key, l, false])
    }
  }
  expect(tr('engineChoiceNotAllowed', 'ko')).toBe('어떤 AI로 답할지는 관리자가 정해요. 그냥 보내면 팀 기본 AI가 답해요.')
})
