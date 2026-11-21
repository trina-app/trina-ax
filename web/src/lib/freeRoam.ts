// A free-roam demo on screen (docs/decisions/20261119-demo-free-roam-web.md; the server side:
// docs/decisions/20261119-demo-free-roam-a.md). One visitor's own server behind demo-gate, signed in as the demo's one
// person, with the real AI until the demo limit. These are the plain rules the screens share; nothing here talks to the
// server (store/demo.ts reads GET /api/demo, components/demo/FreeRoam.tsx draws it).
import { DEMO_BUSY_REASON, DEMO_LIMIT_REASON, DEMO_QUESTION_TOKENS, DEMO_REST_REASON, type ApiErrorBody, type DemoInfo, type Locale, type Me } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

/**
 * Whether this server may be a demo server, so GET /api/demo is worth asking: signed out every server is asked once (the
 * sign-in page); signed in, a development server (`me.server.dev`), or a server whose feature row only a free-roam demo
 * has. A free-roam instance runs in dev mode with every dev flag hidden (`dev` false), and its feature row is all off on
 * a self-installed server (server/src/system/deployment.ts FREE_ROAM_OFF): a real self-installed server, office mode
 * and dev keep update and connected folders on, and the hosted service says `deployment: 'hosted'`. So a normal install
 * never gets the request.
 */
export function mayBeDemoServer(me: Me | null | undefined): boolean {
  if (!me) return true
  if (me.server.dev) return true
  const f = me.server.features
  return !!f && me.server.deployment !== 'hosted' && !f.selfUpdate && !f.connectedFolders && !f.connectionChange && !f.hostDiagnostics
}

export const isFreeRoam = (info: DemoInfo | null | undefined): info is DemoInfo & { kind: 'freeRoam' } => info?.kind === 'freeRoam'

/** The languages a free-roam demo can be in: the ones the demo company is written in and a snapshot can be built in,
 * scripts/demo/steepling/make.ts STEEPLING_LOCALES (demo-gate keeps one snapshot per language;
 * tests/unit/demo-company-seed.test.ts keeps the two lists equal). One instance's sign-in page offers fewer:
 * freeRoamSignInLocales. */
export const FREE_ROAM_LOCALES: readonly Locale[] = ['en', 'ko', 'ja', 'zh', 'es', 'id']

/**
 * The languages one free-roam instance's sign-in page offers (QA TC-5621): its own (the team default its snapshot was
 * built in, GET /api/demo `locale`: demo-gate denies GET /api/setup, QA TC-6790) and English. Not every one of FREE_ROAM_LOCALES: demo-gate runs only some
 * live (`pool.locales`, en and ko by default), and an en or ko instance has no ja, zh, es or id screens of its company.
 * Not known (an older server, a failed request): English only.
 */
export function freeRoamSignInLocales(own: Locale | null | undefined): readonly Locale[] {
  return own && own !== 'en' && FREE_ROAM_LOCALES.includes(own) ? ['en', own] : ['en']
}

/**
 * Whether the demo limit is used up (`out`): the limit dialog opens and every AI message box stops (store/demo.ts).
 * Nothing known: not out. The bar says what is left in questions only (demoQuestionsLeft): the % meter went with the
 * QA of 2026-11-22, which read "About 20% of your demo AI left" as vague.
 */
export function demoMeter(used: number | undefined, cap: number | undefined): { out: boolean } {
  if (!cap || cap <= 0 || used === undefined || !Number.isFinite(used)) return { out: false }
  return { out: Math.max(0, used) >= cap }
}

/**
 * About how many questions the visitor has left: floor((cap - used) / DEMO_QUESTION_TOKENS), never below 0, right to the
 * end (0 while the AI still answers reads "Almost out of questions"). Null when the bar says nothing about it: no limit
 * known, or the limit is used up (the line under the box says so).
 */
export function demoQuestionsLeft(used: number | undefined, cap: number | undefined): number | null {
  if (!cap || cap <= 0 || used === undefined || !Number.isFinite(used) || demoMeter(used, cap).out) return null
  return Math.max(0, Math.floor((cap - Math.max(0, used)) / DEMO_QUESTION_TOKENS))
}

/** The gate's new start opens the app at `/?fresh=1` (demo-gate, the successful start's 303). */
export const FRESH_PARAM = 'fresh'

/**
 * A new visitor's first page on a free-roam instance: the address carries `?fresh=1`. Every demo copy comes from one
 * snapshot, so every copy has the same user id, and what this browser keeps per user id (unsent drafts, queued sends,
 * the box's chips) would be the previous visitor's (QA 2026-11-22 D2). True when the parameter was there; it leaves the
 * address at once (history.replaceState, the router's own state kept), so a reload is not a new start.
 */
export function takeFreshStart(loc: Pick<Location, 'href'> | undefined = globalThis.location, history: Pick<History, 'replaceState' | 'state'> | undefined = globalThis.history): boolean {
  if (!loc?.href) return false
  let url: URL
  try { url = new URL(loc.href) } catch { return false }
  if (url.searchParams.get(FRESH_PARAM) !== '1') return false
  url.searchParams.delete(FRESH_PARAM)
  try { history?.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`) } catch { /* the address keeps it; the cleanup still runs */ }
  return true
}

/** Home's built-in suggestions when the demo file has none of its own (en and ko, the demo's first languages; the
 * others read the English ones through the i18n tables). */
export const BUILT_IN_SUGGESTIONS: readonly MessageKey[] = ['demo.free.chip.posts', 'demo.free.chip.reply', 'demo.free.chip.assets']
export const SUGGESTIONS_MAX = 3

/** one suggestion: the chip's short label and what it sends */
export interface FreeRoamSuggestion { label: string; prompt: string }

/**
 * Home's 2-3 suggestions (under the message box): the demo's own (GET /api/demo `freeRoam.suggestions`, from the demo content, in the
 * company's language: a label for the chip and the prompt it sends), else the person's questions from the demo file,
 * else the built-in ones (their words are the label and the prompt).
 */
export function freeRoamSuggestions(info: DemoInfo, t: (key: MessageKey) => string): FreeRoamSuggestion[] {
  const own: unknown = info.freeRoam?.suggestions
  if (Array.isArray(own)) {
    const list = own.flatMap((x): FreeRoamSuggestion[] => {
      const o = x as { label?: unknown; prompt?: unknown } | null
      const label = typeof o?.label === 'string' ? o.label.trim() : ''
      const prompt = typeof o?.prompt === 'string' ? o.prompt.trim() : ''
      return label && prompt ? [{ label, prompt }] : []
    })
    if (list.length) return list.slice(0, SUGGESTIONS_MAX)
  }
  const me = info.current ? info.personas.find((p) => p.key === info.current) : info.personas[0]
  const asked = (me?.questions ?? []).map((q) => q.trim()).filter(Boolean)
  const words = asked.length ? asked : BUILT_IN_SUGGESTIONS.map((k) => t(k))
  return words.slice(0, SUGGESTIONS_MAX).map((w) => ({ label: w, prompt: w }))
}

export type DemoReason = typeof DEMO_LIMIT_REASON | typeof DEMO_REST_REASON | typeof DEMO_BUSY_REASON | 'demo_fenced' | 'demo_upload'
const REASONS = new Set<string>([DEMO_LIMIT_REASON, DEMO_REST_REASON, DEMO_BUSY_REASON, 'demo_fenced', 'demo_upload'])

/** the free-roam reason of a refusal or a failed answer (params.reason), or null */
export function demoReason(err: Pick<ApiErrorBody, 'params'> | null | undefined): DemoReason | null {
  const r = err?.params?.reason
  return typeof r === 'string' && REASONS.has(r) ? (r as DemoReason) : null
}

/** The web's own words for a failed answer of a free-roam demo (the server sends the same in the person's language;
 * the screen says them from its own tables, like every other answer error). */
export function demoAnswerKey(err: Pick<ApiErrorBody, 'params'> | null | undefined): MessageKey | null {
  const r = demoReason(err)
  return r === DEMO_LIMIT_REASON ? 'demo.free.limit.title' : r === DEMO_REST_REASON ? 'demo.free.rest' : r === DEMO_BUSY_REASON ? 'demo.free.busy' : null
}

/** Settings sections a free-roam visitor never sees: which AI account answers and how much it used (usage, AI
 * providers), the outside AI apps' page (the server's own connection details), the dev environment's sites, Security &
 * devices (the password and the signed-in devices: the account is the demo's, server/src/demo/guard.ts refuses both) and
 * Apps (the phone and computer apps connect to a team's address; a demo instance has none to give). */
export const FREE_ROAM_HIDDEN_SETTINGS: ReadonlySet<string> = new Set(['usage', 'providers', 'ai-apps', 'dev-env-sites', 'security', 'apps'])
/** pages under a Settings section a free-roam visitor never opens, even by address: deleting the demo's account, the
 * password and the devices (the server refuses each) */
export const FREE_ROAM_HIDDEN_PAGES: ReadonlySet<string> = new Set(['account-delete', 'security-password', 'security-devices'])

/** "Continue as {name}" on the sign-in page: demo-gate signs the visitor back in as the demo's person on their own
 * instance (POST /__demo/resume, same origin); anything but a 2xx goes to its start instead (GET /__demo/start, which
 * leads to the gate's landing page). */
export const FREE_ROAM_RESUME_PATH = '/__demo/resume'
export const FREE_ROAM_START_PATH = '/__demo/start'

/** Ask the gate to sign the visitor back in, then open the app; on a failure (or no answer) the gate's start. */
export async function resumeFreeRoam(o: { fetch?: typeof fetch; go?: (to: string) => void } = {}): Promise<void> {
  const go = o.go ?? ((to: string) => window.location.assign(to))
  try {
    const res = await (o.fetch ?? fetch)(FREE_ROAM_RESUME_PATH, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '',
    })
    go(res.ok ? '/' : FREE_ROAM_START_PATH)
  } catch {
    go(FREE_ROAM_START_PATH)
  }
}
