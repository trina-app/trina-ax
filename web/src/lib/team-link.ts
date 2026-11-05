// The team invite link on the web side (contract: shared/src/api/team-links.ts). Pure helpers, so they are tested
// without a browser: reading the token from the address's #fragment, the ready-made message a leader copies into a
// chat app, and where a new member may be sent after joining.
import { TEAM_LINK_FRAGMENT_KEY, type StarterKind } from '@mycel/shared/api'
import type { MessageKey, Params } from '../i18n'

/**
 * The token of a /join#t=<token> address, and the address to put back without it. A fragment never reaches a server
 * log, a proxy or a Referer; the page takes it out of the address bar too (history, screenshots, a shared screen).
 */
export function readJoinToken(loc: { pathname: string; search: string; hash: string }): { token: string | null; cleanUrl: string | null } {
  const frag = new URLSearchParams(loc.hash.replace(/^#/, ''))
  if (!frag.has(TEAM_LINK_FRAGMENT_KEY)) return { token: null, cleanUrl: null }
  const raw = (frag.get(TEAM_LINK_FRAGMENT_KEY) ?? '').trim()
  frag.delete(TEAM_LINK_FRAGMENT_KEY)
  const rest = frag.toString()
  return { token: /^[A-Za-z0-9_-]{16,200}$/.test(raw) ? raw : null, cleanUrl: `${loc.pathname}${loc.search}${rest ? `#${rest}` : ''}` }
}

/** The text a leader pastes into KakaoTalk or Slack: who invites, and the skill to try together when the link names
 * one; `made`: the team skill they just made ("우리 팀 '견적서 쓰기' 스킬을 만들어 뒀어요…"). `name` is the person copying it (they are the one sending it). A link with a starter says what is waiting
 * instead, in the lead's own voice: this week's meeting notes and everyone's own tasks (`tasks`), or the team's files
 * and what each person needs from them (`brief`); the link on its own line. */
export function teamLinkMessage(t: (key: MessageKey, params?: Params) => string, o: { name: string; url: string; skill?: string | null; starter?: StarterKind | null; made?: boolean }): string {
  if (o.starter) return t(o.starter === 'brief' ? 'teamLink.messageBrief' : 'teamLink.messageNotes', { url: o.url })
  // a team skill the lead just made from their own work (docs/DECISIONS.md "S"), in their voice
  if (o.made && o.skill) return t('teamLink.messageMade', { skill: o.skill, url: o.url })
  return o.skill ? t('teamLink.messageSkill', { name: o.name, url: o.url, skill: o.skill }) : t('teamLink.message', { name: o.name, url: o.url })
}

/** Where to go after joining: only the skill form the server named (`/skills?run=<path>`), anything else is Home. */
export function joinNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/skills?run=')) return '/'
  try {
    const u = new URL(next, 'http://x')
    const run = u.searchParams.get('run')
    return u.pathname === '/skills' && run && run.startsWith('skills/') && [...u.searchParams.keys()].length === 1 ? `/skills?run=${encodeURIComponent(run)}` : '/'
  } catch { return '/' }
}

/**
 * Where the person who just joined goes, kept for the signed-in app's /join route (App.tsx AfterJoin). The join page
 * sets it right before the session switches to signed in: that switch re-renders /join as a signed-in page at once,
 * while the router's own navigation is a transition and would arrive after it.
 */
let afterJoin: string | null = null
export const setAfterJoin = (next: string) => { afterJoin = next }
export const afterJoinTarget = (): string => afterJoin ?? '/'
export const clearAfterJoin = () => { afterJoin = null }
