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

/** The languages a free-roam demo has (its sign-in page offers only these, QA TC-5621): the ones the demo company is
 * written in, scripts/demo/steepling/make.ts STEEPLING_LOCALES (demo-gate keeps one snapshot per language). */
export const FREE_ROAM_LOCALES: readonly Locale[] = ['en', 'ko']

/** the meter starts to speak at this share of the demo limit */
export const METER_FROM = 0.8

/**
 * The demo limit as the visitor reads it: nothing until 80 %, then "About N% of your demo AI left" (N in steps of 5,
 * rounded up so it never says 0 before the end), and `out` once it is used up.
 */
export function demoMeter(used: number | undefined, cap: number | undefined): { out: boolean; low: boolean; leftPct: number } {
  if (!cap || cap <= 0 || used === undefined || !Number.isFinite(used)) return { out: false, low: false, leftPct: 100 }
  const share = Math.max(0, used) / cap
  if (share >= 1) return { out: true, low: true, leftPct: 0 }
  const left = (1 - share) * 100
  return { out: false, low: share >= METER_FROM, leftPct: Math.min(20, Math.max(5, Math.ceil(left / 5) * 5)) }
}

/**
 * About how many questions the visitor has left: floor((cap - used) / DEMO_QUESTION_TOKENS), never below 0. Null when
 * the bar says nothing about it: no limit known, or from METER_FROM on, where the meter's "About N% left" takes over
 * (one count at a time, and never "about 0 questions" while the AI still answers).
 */
export function demoQuestionsLeft(used: number | undefined, cap: number | undefined): number | null {
  if (!cap || cap <= 0 || used === undefined || !Number.isFinite(used) || demoMeter(used, cap).low) return null
  return Math.max(0, Math.floor((cap - Math.max(0, used)) / DEMO_QUESTION_TOKENS))
}

/** The bar's built-in suggestions when the demo file has none of its own (en and ko, the demo's first languages; the
 * others read the English ones through the i18n tables). */
export const BUILT_IN_SUGGESTIONS: readonly MessageKey[] = ['demo.free.chip.posts', 'demo.free.chip.reply', 'demo.free.chip.assets']
export const SUGGESTIONS_MAX = 3

/** one suggestion: the chip's short label and what it sends */
export interface FreeRoamSuggestion { label: string; prompt: string }

/**
 * The bar's 2-3 suggestions: the demo's own (GET /api/demo `freeRoam.suggestions`, from the demo content, in the
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
