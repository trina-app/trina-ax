// What the first-run box reads (src/team-link.ts, the same file as shared/src/team-link.ts) with the phone's rules:
// https only, the hosted team domain from the edition (app.config.ts extra.teamAxService), no other domain is tried.
import { parseTeamInput, type TeamInput } from './team-link'

export interface TeamAddress { origin: string; entryPath: string }

/** What was typed or pasted on the first-run screen (an invite or team link, an address, a bare name, a message). */
export function readTeamInput(raw: string, teamDomain: string | null): TeamInput {
  return parseTeamInput(raw, { teamDomain, loopbackHttp: false })
}

/** A full https address or link (a saved team, a stored origin): bare names are not addresses here. An invite or team
 * link keeps its page; a cut-off link is refused rather than quietly opening the sign-in page. */
export function parseTeamAddress(raw: string): TeamAddress | null {
  const p = parseTeamInput(raw, { teamDomain: null, loopbackHttp: false })
  return p.ok ? { origin: p.origin, entryPath: p.entryPath } : null
}
