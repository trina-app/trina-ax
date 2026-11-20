// "다른 팀으로 전환" / Switch team (UX review S6, docs/DECISIONS.md "Switching teams from the logo menu and 나";
// docs/decisions/20261118-team-menu-for-members.md), for every role. The desktop app: its own team screen (the remembered
// teams, Open, Remove from list, Back; openTeams). No menu under the pointer any more (owner 2026-11-15: it floated over
// the rail); the OS menu's 팀 keeps ⌘1–9. The phone app: its own "다른 팀에 연결" screen over the team (change-team-v1),
// the one its signed-out footer opens; a phone app without it has no item (its web view does not leave the team by
// itself). A plain browser, phone or computer, is one team per address: a small dialog takes the other team's address,
// its name under the hosted domain or an invite link (the apps' own reading, shared/src/team-link.ts) and opens it in
// this tab; this team stays signed in at its own address. The page never learns the person's other teams.
import { useSyncExternalStore } from 'react'
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { isLoopbackHost, parseTeamInput, type TeamInputError } from '@mycel/shared/team-link'
import { t, type MessageKey } from '../i18n'
import { promptDialog } from '../components/ui'
import { desktop } from './desktop'
import { appChangesTeam, changeTeamInApp, mobileApp } from './mobile'

export type TeamSwitchWay = 'desktop' | 'app' | 'browser'

/** Inside the phone app's web view: its bridge object is there before the page's own script runs, the app's config may
 * come later (lib/mobile.ts mobileApp) */
const inPhoneApp = () => typeof window !== 'undefined' && (!!mobileApp() || (window.top === window.self && !!(window as { ReactNativeWebView?: unknown }).ReactNativeWebView))

/** How this window switches teams, or null (a phone app without its team screen: no item) */
export function teamSwitchWay(): TeamSwitchWay | null {
  if (desktop()) return 'desktop'
  if (appChangesTeam()) return 'app'
  if (inPhoneApp()) return null
  return 'browser'
}

/** teamSwitchWay, again when the phone app's bridge arrives (it is set after the page loads: 나 may be the first screen) */
export function useTeamSwitchWay(): TeamSwitchWay | null {
  return useSyncExternalStore(
    (on) => {
      window.addEventListener('mycel:mobile-ready', on)
      return () => window.removeEventListener('mycel:mobile-ready', on)
    },
    teamSwitchWay,
    () => null,
  )
}

const PROBLEM: Record<TeamInputError, MessageKey | null> = {
  empty: null,
  email: 'teamSwitch.problem.email',
  link: 'teamSwitch.problem.link',
  insecure: 'teamSwitch.problem.insecure',
  hangul: 'teamSwitch.problem.invalid',
  invalid: 'teamSwitch.problem.invalid',
  short_name: 'teamSwitch.problem.invalid',
  credentials: 'teamSwitch.problem.invalid',
  unsupported_scheme: 'teamSwitch.problem.invalid',
}

/** Where a plain browser goes for what was typed: the team's origin and its first page ('/', an invite link's page, a
 * team link's page), or the words that say what is wrong (null while nothing is typed). Plain http only to this machine
 * and only from a page on this machine (development), as the apps. */
export function browserTeamTarget(raw: string, pageHostname: string): { url: string } | { problem: MessageKey | null } {
  const r = parseTeamInput(raw, { teamDomain: SERVICE_HOSTS.teamDomain, loopbackHttp: isLoopbackHost(pageHostname) })
  if (!r.ok) return { problem: PROBLEM[r.error] }
  return { url: r.origin + r.entryPath }
}

/** The address shown as an example: a hosted team's */
const EXAMPLE = `acme.${SERVICE_HOSTS.teamDomain}`

/** A plain browser's way: the dialog, then the other team in this tab. */
async function switchInBrowser(): Promise<void> {
  const host = location.hostname
  const typed = await promptDialog({
    title: t('teamMenu.switch'),
    body: t('teamSwitch.body'),
    label: t('teamSwitch.label'),
    placeholder: EXAMPLE,
    confirm: t('teamSwitch.open'),
    // a whole pasted message with the link in it (a KakaoTalk bubble): as long as the parser reads
    maxLength: 8192,
    validate: (v) => {
      const r = browserTeamTarget(v, host)
      return 'problem' in r && r.problem ? t(r.problem, { example: EXAMPLE }) : null
    },
  })
  if (!typed) return
  const r = browserTeamTarget(typed, host)
  if ('url' in r) location.assign(r.url)
}

/** Opens this window's way to switch teams (nothing in a phone app without one). */
export function switchTeam(): void {
  const d = desktop()
  if (d) return void d.openTeams()
  if (appChangesTeam()) return void changeTeamInApp().catch(() => {})
  if (!inPhoneApp()) void switchInBrowser()
}
