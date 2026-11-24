// The apps on a person's own computer that Settings › Connectors lists by name, like Slack or Atlassian
// (docs/decisions/20261118-local-app-connectors.md, "Aside and ego lite as their own connectors", 2026-11-19): each has
// its own card in Discover, its logo, a one-line description and an install hint. Their command is the shared preset
// (shared/src/api/local-apps.ts LOCAL_APP_PRESETS), so a card connects with no program picker; any other program is
// added through "Add custom connector" (IntegrationDialog.tsx, "A program on this computer"). Logos are files in
// web/public/icons/connectors, like the listed services' (docs/THIRD-PARTY-NOTICES.md says where each came from).
import { LOCAL_APP_PRESETS, localCommandKey, type Integration, type LocalAppSpec } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

export interface LocalAppEntry {
  /** the preset's id (LOCAL_APP_PRESETS), also its card's id and its page's address (/settings/connectors/<id>) */
  id: 'aside' | 'ego-lite' | 'playwright' | 'chrome-devtools'
  name: string
  /** a file in web/public/icons/connectors */
  logo: string
  /** its one line (what the AI does with it) and what to do before connecting */
  line: MessageKey
  install: MessageKey
  /** what to do when it connects and still cannot reach anything (Aside: an account no Aside Browser profile uses) */
  help?: MessageKey
}

export const LISTED_LOCAL_APPS: readonly LocalAppEntry[] = [
  { id: 'aside', name: 'Aside', logo: 'aside.png', line: 'localApps.aside.line', install: 'localApps.aside.install', help: 'localApps.aside.noProfiles' },
  { id: 'ego-lite', name: 'ego lite', logo: 'ego-lite.svg', line: 'localApps.egoLite.line', install: 'localApps.egoLite.install' },
  { id: 'playwright', name: 'Playwright', logo: 'playwright.svg', line: 'localApps.playwright.line', install: 'localApps.playwright.install' },
  { id: 'chrome-devtools', name: 'Chrome DevTools', logo: 'chrome-devtools.png', line: 'localApps.chromeDevtools.line', install: 'localApps.chromeDevtools.install' },
]

/** The listed apps this computer can run: a preset's `notOn` leaves it out there (Playwright and Chrome DevTools run
 * through npx, which is npx.cmd on Windows). `platform`: the desktop app's (undefined on the web and the phone, where
 * every card shows and says it works in the desktop app). */
export const localAppsFor = (platform: string | undefined): readonly LocalAppEntry[] =>
  LISTED_LOCAL_APPS.filter((a) => !(platform && LOCAL_APP_PRESETS.find((p) => p.id === a.id)?.notOn?.includes(platform)))

export const localAppLogo = (a: LocalAppEntry) => `/icons/connectors/${a.logo}`
export const localAppById = (id: string) => LISTED_LOCAL_APPS.find((a) => a.id === id) ?? null
export const localAppSpec = (a: LocalAppEntry): LocalAppSpec => LOCAL_APP_PRESETS.find((p) => p.id === a.id)!.spec

/** Two commands run the same program the same way: the part the computer's confirm covers (its settings' names aside:
 * those are the person's own). */
const sameCommand = (a: LocalAppSpec, b: LocalAppSpec) => localCommandKey(a) === localCommandKey(b)

/** The listed app a connection on the computer runs (Aside, ego lite), else null: a program the person typed. */
export function localAppOf(i: Pick<Integration, 'kind' | 'local'>): LocalAppEntry | null {
  if (i.kind !== 'local' || !i.local) return null
  return LISTED_LOCAL_APPS.find((a) => sameCommand(localAppSpec(a), i.local!)) ?? null
}
