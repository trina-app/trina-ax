// The team's company profile (docs/DECISIONS.md "D — Company profile from the company website"): one JSON file,
// skills/company-profile.json. Under skills/ because only the owner and admins write there by default (shared/ is
// everyone's) while everyone reads it, so it shows in Files and its read rule decides who gets it. JSON, not
// Markdown: the team-rule reader (chat/prompt.ts teamRuleFiles) and the skill reader (chat/skills.ts) take only .md
// files, so this file can never become a rule or a skill whatever it holds. The AI gets the facts as their own
// <company_profile> block (chat/prompt.ts companyProfileBlock), never as instructions.
import type { CompanyProfile, CompanyProfileInput, Locale, ProfileField } from '@mycel/shared/api'
import { normalizeWebsite, PROFILE_BLOCK_MAX, PROFILE_FIELDS, PROFILE_LIMITS, profileName } from '@mycel/shared/api'
import type { FileService } from '../files/service'
import { readRegular, sha256 } from '../files/store'
import type { Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { HttpError } from '../http/errors'
import { normUrl } from '../tools/url-gate'

export const PROFILE_PATH = 'skills/company-profile.json'
/** a hand-edited file larger than this is not read */
const PROFILE_FILE_MAX_BYTES = 64 * 1024

/** A field's text: line ends unified, spaces folded inside each line, blank lines dropped, trimmed, cut to `max`. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const lines = v.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim()).filter(Boolean)
  return lines.join('\n').slice(0, max).trim()
}

/** Tone chips: short words, no repeats (case-insensitive), at most PROFILE_LIMITS.toneCount. */
export function cleanTone(v: unknown): string[] {
  const out: string[] = []
  for (const t of Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n·]/) : []) {
    const s = cleanText(t, PROFILE_LIMITS.toneItem).replace(/\n/g, ' ')
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s)
    if (out.length >= PROFILE_LIMITS.toneCount) break
  }
  return out
}

/** Brand colours: "#rrggbb" (lower case; "#abc" widened), no repeats, at most PROFILE_LIMITS.colors. */
export function cleanColors(v: unknown): string[] {
  const out: string[] = []
  for (const c of Array.isArray(v) ? v : []) {
    if (typeof c !== 'string') continue
    let s = c.trim().toLowerCase()
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((x) => x + x).join('')
    if (/^#[0-9a-f]{6}$/.test(s) && !out.includes(s)) out.push(s)
    if (out.length >= PROFILE_LIMITS.colors) break
  }
  return out
}

const isField = (f: unknown): f is ProfileField => typeof f === 'string' && (PROFILE_FIELDS as readonly string[]).includes(f)

/**
 * A profile from untrusted JSON (a draft the AI wrote, a file someone edited): every field cleaned and cut to its
 * limit, unknown keys dropped. `sourceOk` decides which source addresses stay ('' = pasted text or the person's own
 * answer); a source of a field left empty, or a second one for the same field, is dropped. null when `raw` is not an
 * object.
 */
export function cleanProfile(raw: unknown, sourceOk: (url: string) => boolean = (u) => u === '' || !!normUrl(u)): CompanyProfileInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const p: CompanyProfileInput = {
    website: normalizeWebsite(cleanText(r.website, PROFILE_LIMITS.website)) ?? '',
    name: cleanText(r.name, PROFILE_LIMITS.name).replace(/\n/g, ' '),
    oneLine: cleanText(r.oneLine, PROFILE_LIMITS.oneLine).replace(/\n/g, ' '),
    products: cleanText(r.products, PROFILE_LIMITS.products),
    audience: cleanText(r.audience, PROFILE_LIMITS.audience),
    tone: cleanTone(r.tone),
    avoid: cleanText(r.avoid, PROFILE_LIMITS.avoid),
    sources: [],
    ...(() => { const c = cleanColors(r.colors); return c.length ? { colors: c } : {} })(),
  }
  const seen = new Set<string>()
  for (const s of Array.isArray(r.sources) ? r.sources : []) {
    if (p.sources.length >= PROFILE_LIMITS.sources) break
    if (!s || typeof s !== 'object') continue
    const { field, url, excerpt } = s as Record<string, unknown>
    if (!isField(field) || seen.has(field) || !filled(p, field)) continue
    const u = typeof url === 'string' && url.trim() ? normUrl(url.trim()) ?? '' : ''
    if ((typeof url === 'string' && url.trim() && !u) || u.length > PROFILE_LIMITS.sourceUrl || !sourceOk(u)) continue
    seen.add(field)
    p.sources.push({ field, url: u, excerpt: cleanText(excerpt, PROFILE_LIMITS.excerpt).replace(/\n/g, ' ') })
  }
  return p
}

const filled = (p: CompanyProfileInput, f: ProfileField) => (f === 'tone' ? p.tone.length > 0 : (p[f] ?? '').length > 0)
/** Nothing worth giving the AI (or keeping as a draft). */
export const profileEmpty = (p: CompanyProfileInput) => !p.website && PROFILE_FIELDS.every((f) => !filled(p, f)) && !p.colors?.length

/** The facts as the AI reads them: fixed English labels, one line per field (line breaks inside a field become
 * " · "), empty fields left out, at most `max` characters in all (lines that do not fit are left out). The company
 * name is the profile's, else `teamName` (Admin › Team settings). Tags are neutralized by the caller. */
export function profileFactLines(p: CompanyProfileInput, max = PROFILE_BLOCK_MAX, teamName = ''): string[] {
  const one = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).join(' · ')
  const name = profileName(p, teamName)
  const lines = [
    name ? `Company name: ${name}` : '',
    p.website ? `Website: ${p.website}` : '',
    p.oneLine ? `One-line intro: ${one(p.oneLine)}` : '',
    p.products ? `Products and services: ${one(p.products)}` : '',
    p.audience ? `Customers: ${one(p.audience)}` : '',
    p.tone.length ? `Tone of voice: ${p.tone.join(', ')}` : '',
    p.avoid ? `Expressions to avoid: ${one(p.avoid)}` : '',
    p.colors?.length ? `Brand colors (main first): ${p.colors.join(', ')}` : '',
  ].filter(Boolean)
  const out: string[] = []
  let used = 0
  for (const l of lines) {
    if (used + l.length + 1 > max) break
    out.push(l)
    used += l.length + 1
  }
  return out
}

/** The profile file as `user` may read it (folder rules of skills/), or null: no file, no access, not JSON. */
export function readCompanyProfile(files: FileService, user: Principal): CompanyProfile | null {
  try {
    const r = authorize(files.fx, files.rules(), user, PROFILE_PATH, 'read')
    if (!r.st?.isFile() || r.st.size > PROFILE_FILE_MAX_BYTES) return null
    const raw = JSON.parse(readRegular(r.abs, PROFILE_FILE_MAX_BYTES).bytes.toString('utf8')) as Record<string, unknown>
    const p = cleanProfile(raw)
    if (!p || profileEmpty(p)) return null
    const at = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)) ? new Date(raw.updatedAt).toISOString() : r.st.mtime.toISOString()
    return { ...p, updatedAt: at }
  } catch { return null }
}

const SAVE_TEXT: Record<'website' | 'tooLong' | 'source', Record<Locale, string>> = {
  website: {
    ko: '홈페이지 주소가 올바르지 않아요. 예: https://acme.example',
    en: 'The website address is not valid. Example: https://acme.example',
    id: 'Alamat situs web tidak valid. Contoh: https://acme.example',
    ja: 'ホームページのアドレスが正しくありません。例: https://acme.example',
    es: 'La dirección del sitio web no es válida. Ejemplo: https://acme.example',
  },
  tooLong: {
    ko: `회사 소개가 너무 길어요. 모두 합쳐 ${PROFILE_BLOCK_MAX}자 안으로 줄여 주세요.`,
    en: `The company profile is too long. Keep it under ${PROFILE_BLOCK_MAX} characters in all.`,
    id: `Profil perusahaan terlalu panjang. Buat total di bawah ${PROFILE_BLOCK_MAX} karakter.`,
    ja: `会社紹介が長すぎます。合計${PROFILE_BLOCK_MAX}文字以内にしてください。`,
    es: `El perfil de la empresa es demasiado largo. Manténgalo por debajo de ${PROFILE_BLOCK_MAX} caracteres en total.`,
  },
  source: {
    ko: '출처 주소가 올바르지 않아요.',
    en: 'A source address is not valid.',
    id: 'Alamat sumber tidak valid.',
    ja: '出典のアドレスが正しくありません。',
    es: 'Una dirección de origen no es válida.',
  },
}

/**
 * Save the profile a person checked (PUT): fields cleaned like a draft, the website and source addresses checked, the
 * rendered facts within PROFILE_BLOCK_MAX. Written as that person through the file layer (versions, files.changed,
 * the folder rules of skills/: an admin the rules do not let write there gets the file screen's refusal). The file's
 * own `version` says which shape it has.
 */
export function saveCompanyProfile(files: FileService, userId: string, input: CompanyProfileInput, locale: Locale, now = new Date()): CompanyProfile {
  if (input.website.trim() && !normalizeWebsite(input.website)) throw new HttpError('validation', SAVE_TEXT.website[locale], { fields: { 'body.website': 'invalid' } })
  for (const [i, s] of input.sources.entries()) {
    if (s.url.trim() && !normUrl(s.url.trim())) throw new HttpError('validation', SAVE_TEXT.source[locale], { fields: { [`body.sources.${i}.url`]: 'invalid' } })
  }
  const p = cleanProfile(input)!
  // all of it must reach the AI: a profile whose facts would be cut is refused, not saved to be cut silently
  const lines = profileFactLines(p, Infinity)
  if (lines.reduce((n, l) => n + l.length + 1, 0) > PROFILE_BLOCK_MAX) throw new HttpError('validation', SAVE_TEXT.tooLong[locale], { fields: { body: 'too_long' } })
  const profile: CompanyProfile = { ...p, updatedAt: now.toISOString() }
  const text = JSON.stringify({ version: 1, ...profile }, null, 2) + '\n'
  const user = files.principal(userId)
  let base: string | null = null
  try {
    const r = authorize(files.fx, files.rules(), user, PROFILE_PATH, 'read')
    if (r.st?.isFile()) base = sha256(readRegular(r.abs, PROFILE_FILE_MAX_BYTES * 4).bytes)
  } catch { /* none yet, or not readable: the write decides */ }
  files.humanSave(userId, PROFILE_PATH, Buffer.from(text, 'utf8'), base)
  return profile
}
