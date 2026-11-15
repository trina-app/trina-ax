// Find work files on this computer, part 4 (docs/DECISIONS.md "Find work files, part 4"): the words the page matches a
// file against to tell a company's file from the rest, on the computer, with no file read: the company's names (the
// team's name, the profile's name, without "Inc.", "주식회사" and the like), its domains (the profile's website, the
// work email domains of the team's people, never a public mail provider), and the team's people's names (a document's
// author). GET /api/onboarding/files/company. What the person may see anyway (the team's name, the people list); nothing
// is sent anywhere by it.
import { PRODUCT } from '@mycel/shared'
import { getTeamSettings } from '../admin/settings'
import type { AppContext } from '../context'
import { readCompanyProfile } from './profile'

/** Mail providers anyone can use: their domain says nothing about the company. */
const PUBLIC_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|yandex|zoho|naver|daum|hanmail|kakao|nate|qq|163|126|sina|foxmail|yeah)\.[a-z.]+$/i

/** Legal forms and company words that are no part of a name ("Acme Inc." → "Acme", "주식회사 에이크미" → "에이크미"). */
const LEGAL = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|llp|plc|gmbh|ag|sa|sas|srl|bv|nv|pty|pte|pt|tbk|cv|kk|ug)\b\.?|주식회사|\(주\)|㈜|유한회사|株式会社|有限会社|有限公司|股份有限公司|集团/gi

/** A company name as it is matched: legal forms out, spaces folded; '' when nothing is left or it is too short. */
export function companyName(raw: string): string {
  const s = raw.normalize('NFC').replace(LEGAL, ' ').replace(/[.,·]+/g, ' ').replace(/\s+/g, ' ').trim()
  return /[\u3040-\u9fff\uac00-\ud7a3]/.test(s) ? (s.length >= 2 ? s : '') : s.length >= 3 ? s : ''
}

/** The registrable part of a host, as people write it in names: "www.acme.co.kr" → "acme.co.kr". */
export function bareDomain(host: string): string {
  return host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
}

export interface CompanyWords { names: string[]; domains: string[]; people: string[] }

export function companyWords(ctx: AppContext, userId: string): CompanyWords {
  const names = new Set<string>()
  const domains = new Set<string>()
  const add = (n: string | null | undefined) => { const c = n ? companyName(n) : ''; if (c) names.add(c) }
  // the team's name, unless it is still the product's own default (it would match every file named after the app)
  const team = getTeamSettings(ctx.db).teamName
  if (team && team !== PRODUCT.displayName) add(team)
  try {
    const p = readCompanyProfile(ctx.files, ctx.files.principal(userId))
    add(p?.name)
    if (p?.website) {
      try { domains.add(bareDomain(new URL(/^https?:\/\//i.test(p.website) ? p.website : `https://${p.website}`).hostname)) } catch { /* not an address */ }
    }
  } catch { /* no profile */ }
  // the caller's own name is left out: Office writes it into everything they made, their own CV too
  const users = ctx.db.query("SELECT id, name, email FROM users WHERE status = 'active' AND deleted_at IS NULL AND guest = 0 LIMIT 500").all() as { id: string; name: string | null; email: string | null }[]
  for (const u of users) {
    const d = u.email?.split('@')[1]
    if (d && !PUBLIC_MAIL.test(d)) domains.add(bareDomain(d))
  }
  const people = users.filter((u) => u.id !== userId).map((u) => (u.name ?? '').trim()).filter((n) => n.length >= 2).slice(0, 300)
  return { names: [...names].slice(0, 5), domains: [...domains].slice(0, 10), people }
}
