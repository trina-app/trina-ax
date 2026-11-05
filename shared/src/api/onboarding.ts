// Onboarding: the team's company profile (docs/DECISIONS.md "D — Company profile from the company website"). Route
// module: server/src/routes/onboarding.ts. The profile is a JSON file under skills/ (only owner / admins write it by
// default, everyone reads it), never a team rule or a skill; the AI gets it as a <company_profile> facts block
// (server/src/chat/prompt.ts). A draft is a normal chat turn of the owner or admin with web_fetch only, on the site
// they typed (at most 4 pages); the person checks, edits and saves it with PUT.
import { z } from 'zod'
import { endpoint } from './endpoint'
import { SKILL_SHARE } from './onboarding-skill'

/** The fields of a profile that reach the AI (website besides). Skill inputs read them as `company.<field>`. `name`
 * (the company's name) is optional: profiles saved before it have none, and an empty one reads as the team's name. */
export const PROFILE_FIELDS = ['name', 'oneLine', 'products', 'audience', 'tone', 'avoid'] as const
export const ProfileField = z.enum(PROFILE_FIELDS)
export type ProfileField = z.infer<typeof ProfileField>

/** Characters per field (and the source lines). Together they keep the prompt block under PROFILE_BLOCK_MAX. */
export const PROFILE_LIMITS = {
  website: 200, name: 80, oneLine: 120, products: 400, audience: 300, avoid: 300,
  /** tone: at most this many chips, each at most toneItem characters */
  toneCount: 4, toneItem: 20,
  sources: 10, sourceUrl: 500, excerpt: 200,
  /** brand colours (#rrggbb), at most this many */
  colors: 5,
} as const
/** A brand colour as the profile keeps it: "#rrggbb", lower case. */
export const BrandColor = z.string().regex(/^#[0-9a-f]{6}$/)
/** The rendered facts of a profile (labels included) in the AI's instructions: at most this many characters. */
export const PROFILE_BLOCK_MAX = 2000
/** A draft from pasted text: at most this many characters of it. */
export const PROFILE_TEXT_MAX = 8000

/** Where a field came from: the page (url, '' for pasted text or the person's own answer) and a short quote of it. */
export const ProfileSource = z.object({
  field: ProfileField,
  url: z.string().max(PROFILE_LIMITS.sourceUrl),
  excerpt: z.string().max(PROFILE_LIMITS.excerpt),
}).strict()
export type ProfileSource = z.infer<typeof ProfileSource>

/** A profile as the person saves it (PUT) and as a draft comes back: every field may be empty. */
export const CompanyProfileInput = z.object({
  website: z.string().max(PROFILE_LIMITS.website),
  /** the company's name ("회사 이름"); absent or empty: the team's name stands in (profileName) */
  name: z.string().max(PROFILE_LIMITS.name).optional(),
  oneLine: z.string().max(PROFILE_LIMITS.oneLine),
  products: z.string().max(PROFILE_LIMITS.products),
  audience: z.string().max(PROFILE_LIMITS.audience),
  tone: z.array(z.string().max(PROFILE_LIMITS.toneItem)).max(PROFILE_LIMITS.toneCount),
  avoid: z.string().max(PROFILE_LIMITS.avoid),
  sources: z.array(ProfileSource).max(PROFILE_LIMITS.sources),
  /** the brand colours (main first), read from the website by the server (its theme colour, its style sheets, the
   * logo) and kept or removed by the person; absent on profiles from before them (docs/DECISIONS.md "N") */
  colors: z.array(BrandColor).max(PROFILE_LIMITS.colors).optional(),
}).strict()
export type CompanyProfileInput = z.infer<typeof CompanyProfileInput>

export const CompanyProfile = CompanyProfileInput.extend({ updatedAt: z.string() })
export type CompanyProfile = z.infer<typeof CompanyProfile>

export const CompanyProfileResponse = z.object({ profile: CompanyProfile.nullable() })
export type CompanyProfileResponse = z.infer<typeof CompanyProfileResponse>

/** Start a draft: from the company website (http(s), a name with a registrable domain) or from text the person pasted. */
export const StartProfileDraft = z.object({
  website: z.string().max(PROFILE_LIMITS.website).optional(),
  text: z.string().max(PROFILE_TEXT_MAX).optional(),
}).strict()
export type StartProfileDraft = z.infer<typeof StartProfileDraft>

export const ProfileDraftStarted = z.object({
  chatId: z.string(),
  /** the address the AI starts from (normalized), '' for pasted text */
  website: z.string(),
  /** what the AI may read: a host with its subdomains ("acme.co.kr"), or on a shared platform a host and path
   * ("blog.naver.com/acme"); null for pasted text */
  site: z.string().nullable(),
})
export type ProfileDraftStarted = z.infer<typeof ProfileDraftStarted>

/** Pages one answer of a draft may open (the server counts each before it opens it; a failed one counts too). */
export const PROFILE_DRAFT_PAGES_MAX = 4
/** At most this many page lines are kept per answer (the AI may keep asking for refused ones). */
export const PROFILE_DRAFT_STEPS_MAX = 20

/** Why a page of a draft was not read: off_site (outside the typed site: the address, or a redirect hop), limit (the
 * pages were used up), not_linked (an address neither typed nor linked from a page read), unreachable (no answer, an
 * error page, a type it cannot read), empty (opened, but almost no text: a page that needs a browser to show). */
export const ProfileDraftPageReason = z.enum(['off_site', 'limit', 'not_linked', 'unreachable', 'empty'])
export type ProfileDraftPageReason = z.infer<typeof ProfileDraftPageReason>

/** One page the server opened or refused for the draft's latest answer, as the server saw it (never what the AI only
 * meant to open). No page text. */
export const ProfileDraftPage = z.object({
  /** the address the AI asked for */
  url: z.string(),
  /** where it ended up after redirects (ok), or the redirect hop that was refused (off_site); null otherwise */
  finalUrl: z.string().nullable(),
  /** refused: never opened, no page used; failed: a page used, nothing to read */
  status: z.enum(['running', 'ok', 'refused', 'failed']),
  reason: ProfileDraftPageReason.nullable(),
  /** the page's own title when it has one (text the site chose: show it as text) */
  title: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
})
export type ProfileDraftPage = z.infer<typeof ProfileDraftPage>

export const ProfileDraftState = z.object({
  /** running: queued or answering; done: the answer is in (draft null when it held no usable JSON); failed: the
   * answer ended with an error or was stopped */
  status: z.enum(['running', 'done', 'failed']),
  website: z.string(),
  draft: CompanyProfileInput.nullable(),
  /** the answer's error text (the person's language) when it failed */
  error: z.string().nullable(),
  /** the pages of the latest answer, oldest first (pasted text: none). Absent from servers before it. */
  steps: z.array(ProfileDraftPage).max(PROFILE_DRAFT_STEPS_MAX).optional(),
  /** running, no page open, and a page was opened before (or the answer has begun its JSON): the AI is working on the
   * profile from what it read (it may still open another page). Absent: not known. */
  writing: z.boolean().optional(),
  /** what the server collected from the pages it opened for the latest answer (docs/DECISIONS.md "N"): images it saved
   * aside for the brand folder (the logo among them when there was one) and the brand colours it found, main first.
   * The images go into the team's brand folder when the first result starts. Absent from servers before it. */
  assets: z.object({ images: z.number().int().nonnegative(), logo: z.boolean(), colors: z.array(BrandColor).max(PROFILE_LIMITS.colors) }).optional(),
})
export type ProfileDraftState = z.infer<typeof ProfileDraftState>

/** A website as typed ("acme.co.kr", "https://www.acme.co.kr/about"): https:// added when there is no scheme; http(s)
 * only, no user name or password, a dotted host name, the default port; the #fragment dropped. null when it is not
 * one. The server also requires a registrable domain (server/src/onboarding/draft.ts). */
export function normalizeWebsite(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password || u.port) return null
  if (!u.hostname.includes('.') || u.hostname.startsWith('[')) return null
  u.hash = ''
  return u.href.length > PROFILE_LIMITS.website ? null : u.href
}

/** The company's name as everything uses it: the profile's own, else the team's name (Admin › Team settings). */
export const profileName = (p: Pick<CompanyProfileInput, 'name'> | null | undefined, teamName = ''): string =>
  (p?.name ?? '').trim() || teamName.trim()

/** The skill-input prefill keys (stream C reads them): `company.<field>` and `company.website`, each as text (tone chips
 * joined with ", "). Empty fields are left out; no profile, no keys. `company.name` falls back to `teamName`. */
export function profilePrefill(p: CompanyProfileInput | null | undefined, teamName = ''): Record<string, string> {
  if (!p) return {}
  const out: Record<string, string> = {}
  for (const f of ['website', ...PROFILE_FIELDS] as const) {
    const v = f === 'tone' ? p.tone.join(', ') : f === 'name' ? profileName(p, teamName) : p[f]
    if (v.trim()) out[`company.${f}`] = v.trim()
  }
  return out
}

export const ONBOARDING = {
  getCompanyProfile: endpoint({ method: 'GET', path: '/api/onboarding/profile', auth: 'user', owner: 'B', response: CompanyProfileResponse,
    summary: 'The team\'s company profile (skills/company-profile.json) when the caller can read it, else null.' }),
  saveCompanyProfile: endpoint({ method: 'PUT', path: '/api/onboarding/profile', auth: 'admin', owner: 'B', body: CompanyProfileInput, response: CompanyProfile,
    summary: 'Save the company profile a person checked (owner or admin, and the folder rules of skills/ must let them write).' }),
  startProfileDraft: endpoint({ method: 'POST', path: '/api/onboarding/profile/draft', auth: 'admin', owner: 'B', body: StartProfileDraft, response: ProfileDraftStarted, status: 201,
    summary: 'Draft the company profile in a new chat of the caller: the AI reads the website (that host or platform path, at most 4 pages) or the pasted text.' }),
  getProfileDraft: endpoint({ method: 'GET', path: '/api/onboarding/profile/draft/:chatId', auth: 'admin', owner: 'B', response: ProfileDraftState,
    summary: 'The state of a profile draft chat of the caller: the draft read from its latest answer, and the pages the server opened or refused for it (addresses, titles and outcomes, no page text).' }),
  // the lead's way of working becomes a team skill (onboarding-skill.ts)
  ...SKILL_SHARE,
} as const
