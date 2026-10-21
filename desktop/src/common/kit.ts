// A "kit" build for one team (docs/office/windows-guide.html): `TEAMAX_KIT_TEAM=exampleteam.example.com TEAMAX_KIT_LOCALE=ko
// bun run dist:win` writes dist/kit.json, and the app then fills in that team address on the first-run screen and
// shows its own screens in that language until the team page says otherwise. Only a suggestion: the person still
// presses Connect, the address goes through the same checks (parseTeamAddress, /api/health), and nothing is added on
// its own. Pure: no Electron, unit-tested in tests/unit/e-desktop-common.test.ts.
import { parseTeamAddress } from './address'
import { asUiLocale, type UiLocale } from './locales'

export interface Kit {
  /** what the first-run screen fills in (the host: "exampleteam.example.com"), or null */
  team: string | null
  /** language of the app's own screens before the team page reports one, or null (the default) */
  locale: UiLocale | null
}

export const NO_KIT: Kit = { team: null, locale: null }

/** kit.json's contents (or the build's environment) -> a checked kit; anything unusable is dropped, never guessed. */
export function parseKit(v: unknown): Kit {
  if (!v || typeof v !== 'object') return NO_KIT
  const o = v as Record<string, unknown>
  let team: string | null = null
  if (typeof o.team === 'string' && o.team.length <= 253) {
    const p = parseTeamAddress(o.team)
    // a kit is for a real team address: never a development address
    if (p.ok && !p.dev) team = p.host
  }
  return { team, locale: asUiLocale(o.locale) }
}
