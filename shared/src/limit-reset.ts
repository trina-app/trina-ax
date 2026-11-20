// When a usage limit can be used again: a day's or a month's limit ends at the team's midnight. Said in 24-hour time,
// so midnight never reads as noon ("오전 12:00", "12:00 AM"); Korean names the hour alone ("11월 12일 0시").
// The refusal (server/src/admin/budgets.ts budgetBlock) and Settings › 사용량 (web MyUsage) say it the same way.
import type { Locale } from './api/common'

const TAG: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US', id: 'id-ID', ja: 'ja-JP', es: 'es', zh: 'zh-CN' }

export function limitResetText(at: Date, locale: Locale, timeZone?: string): string {
  const o: Intl.DateTimeFormatOptions = locale === 'ko'
    ? { month: 'short', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  return new Intl.DateTimeFormat(TAG[locale] ?? TAG.en, { ...o, ...(timeZone ? { timeZone } : {}) }).format(at)
}

/** "this month's" / "today's" as the used-up words below say it. */
export const LIMIT_PERIOD_WORDS: Record<'day' | 'month', Record<Locale, string>> = {
  day: { ko: '오늘', en: "today's", id: 'hari ini', ja: '今日', es: 'de hoy', zh: '今天的' },
  month: { ko: '이번 달', en: "this month's", id: 'bulan ini', ja: '今月', es: 'de este mes', zh: '本月的' },
}

/**
 * What a person reads when a "block" usage limit of theirs is used up: when it starts again and whom to ask. One text
 * for the refusal of a send and the answer a used-up limit stopped (server/src/admin/budgets.ts budgetBlock), and for
 * the web app, which says a stored one again in the language the person reads the app in now (QA AP-077: an answer
 * stopped in Korean still read Korean after switching to English). `who`: a member asks an admin; a guest the person
 * who invited them, and with their own token limit (`amount`, already formatted) its amount.
 */
export function limitUsedUpText(o: { locale: Locale; period: 'day' | 'month'; at: string; who: 'member' | 'guest'; amount?: string }): string {
  const { locale, at } = o
  const p = LIMIT_PERIOD_WORDS[o.period][locale] ?? LIMIT_PERIOD_WORDS[o.period].en
  const n = o.amount
  const t: Record<Locale, string> = o.who === 'guest' && n ? {
    ko: `${p} AI 한도(${n} 토큰)를 다 썼어요. ${at}부터 다시 쓸 수 있어요. 더 필요하면 초대한 분께 물어봐 주세요.`,
    en: `You have used up ${p} AI limit (${n} tokens). You can use it again from ${at}. Ask the person who invited you if you need more.`,
    id: `Batas AI ${p} (${n} token) sudah habis. Anda bisa memakainya lagi mulai ${at}. Tanyakan ke orang yang mengundang Anda jika perlu lebih.`, ja: `${p}のAIの上限（${n}トークン）を使い切りました。${at}から再び使用できます。追加が必要な場合は、招待してくれた人に聞いてください。`, es: `Agotó el límite de IA ${p} (${n} tokens). Podrá volver a usarla a partir de ${at}. Si necesita más, pregunte a quien le invitó.`,
    zh: `${p}AI额度（${n} token）已用完。从${at}起可以再次使用。如果需要更多，请询问邀请你的人。`,
  } : o.who === 'guest' ? {
    ko: `${p} AI 사용 한도를 다 썼어요. ${at}부터 다시 쓸 수 있어요. 더 필요하면 초대한 분께 물어봐 주세요.`,
    en: `You have used up ${p} AI usage limit. You can use it again from ${at}. Ask the person who invited you if you need more.`,
    id: `Batas penggunaan AI ${p} sudah habis. Anda bisa memakainya lagi mulai ${at}. Tanyakan ke orang yang mengundang Anda jika perlu lebih.`, ja: `${p}のAI使用量上限を使い切りました。${at}から再び使用できます。追加が必要な場合は、招待してくれた人に聞いてください。`, es: `Agotó el límite de uso de IA ${p}. Podrá volver a usarla a partir de ${at}. Si necesita más, pregunte a quien le invitó.`,
    zh: `${p}AI用量上限已用完。从${at}起可以再次使用。如果需要更多，请询问邀请你的人。`,
  } : {
    ko: `${p} AI 사용 한도를 다 썼어요. ${at}부터 다시 쓸 수 있어요. 더 필요하면 관리자에게 말해 주세요.`,
    en: `You have used up ${p} AI usage limit. You can use it again from ${at}. Ask an admin if you need more.`,
    id: `Batas penggunaan AI ${p} sudah habis. Anda bisa memakainya lagi mulai ${at}. Minta admin jika perlu lebih.`, ja: `${p}のAI使用量上限を使い切りました。${at}から再び使用できます。追加が必要な場合は管理者にご相談ください。`, es: `Agotó el límite de uso de IA ${p}. Podrá volver a usarla a partir de ${at}. Consulte a un administrador si necesita más.`,
    zh: `${p}AI用量上限已用完。从${at}起可以再次使用。如果需要更多，请联系管理员。`,
  }
  return t[locale] ?? t.en
}
