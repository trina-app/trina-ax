// Which of the person's linked browser profiles a browser call goes to (docs/decisions/20261128-trina-in-chrome.md).
// One rule for the in-app AI (chat/tools.ts) and the person's own MCP apps (connectors/remote-mcp/browser.ts).
import { urlsOf } from '../realtime/browser-tools'
import { siteCovers } from './store'

/** `app`: the desktop app's own browser next to the chat, one more choice in a desktop-app turn (id APP_PROFILE_ID) */
export interface ChromeProfile { linkId: string; label: string; email: string | null; online: boolean; sites: string[]; onlyListed: boolean; app?: boolean }

/** the id the AI names the desktop app's own browser by (`profile: "app"`); never a link id (those are uuids) */
export const APP_PROFILE_ID = 'app'

/** A profile's name as a shared chat shows it (its cards, steps and the AI's list): a name that is an email address (the
 * extension names a profile after its Google account) keeps only its part before the @ ("ann@…"): the person still
 * recognises it, the chat's other members do not get the address (docs/decisions/20261128-chrome-default-browser-name.md). */
export function sharedChatLabel(label: string): string {
  const v = label.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? `${v.slice(0, v.indexOf('@'))}@…` : label
}

/** Strip `profile` from a call's input (and a batch's actions): what the extension gets has none. */
export function withoutProfile(args: Record<string, unknown>): Record<string, unknown> {
  const { profile: _p, ...rest } = args
  void _p
  if (Array.isArray(rest.actions)) rest.actions = rest.actions.map((a) => a && typeof a === 'object' && (a as { input?: unknown }).input && typeof (a as { input: unknown }).input === 'object' ? { ...(a as object), input: withoutProfile((a as { input: Record<string, unknown> }).input) } : a)
  return rest
}

/**
 * The `profile` a call names (name, account email when only one profile has it, or id; a batch's own or its first
 * action's), else the profile this run used last, else the one whose sites hold the call's address (only when exactly
 * one does), else the only linked browser profile open (several: the AI asks), else the desktop app's own browser (in a
 * desktop-app turn, docs/decisions/20261128-browser-profiles-every-turn.md). A named or pinned profile that is not open
 * is refused, never swapped for another.
 * `ready`: the profile is connected now.
 */
export function pickProfile<P extends ChromeProfile>(ps: readonly P[], current: string | null, ready: (p: P) => boolean, tool: string, raw: Record<string, unknown>, ask = 'ask the user once (ask_user)'): { profile: P; args: Record<string, unknown> } | { refused: string; why: string } {
  const names = ps.map((p) => `"${p.label}"`).join(', ')
  let asked = typeof raw.profile === 'string' ? raw.profile.trim() : ''
  if (!asked && tool === 'browser_batch' && Array.isArray(raw.actions)) {
    for (const a of raw.actions as { input?: { profile?: unknown } }[]) if (typeof a?.input?.profile === 'string') { asked = a.input.profile.trim(); break }
  }
  const args = withoutProfile(raw)
  if (asked) {
    const k = asked.toLowerCase()
    const byName = ps.filter((x) => x.label.toLowerCase() === k)
    // a linked profile the person named "app" next to the app's own browser: which one is meant
    const appToo = ps.some((x) => x.app) && k === APP_PROFILE_ID && byName.some((x) => !x.app)
    if ((!ps.some((x) => x.linkId === asked) || appToo) && byName.length > 1) return { refused: `Several browser profiles are named "${byName[0]!.label}": pass the id of the one you mean (${byName.map((x) => x.linkId).join(', ')}), or ask the user which account to use.`, why: 'same name' }
    const p = ps.find((x) => x.linkId === asked) ?? byName[0] ?? (ps.filter((x) => x.email?.toLowerCase() === k).length === 1 ? ps.find((x) => x.email?.toLowerCase() === k) : undefined)
    if (!p) return { refused: `No browser profile named "${asked.slice(0, 80)}". The user's profiles: ${names || 'none'}.`, why: 'unknown' }
    if (!ready(p)) return { refused: `The browser profile "${p.label}" is not open now (its browser is closed or offline). Do not use another profile instead; tell the user to open it, or ask which profile to use.`, why: 'offline' }
    return { profile: p, args }
  }
  const last = current ? ps.find((x) => x.linkId === current) : undefined
  if (last && ready(last)) return { profile: last, args }
  const hosts = urlsOf(tool, args).map((u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).hostname } catch { return '' } }).filter(Boolean)
  if (hosts.length) {
    const pinned = ps.filter((p) => siteCovers(p.sites, hosts[0]!))
    if (pinned.length === 1) {
      if (!ready(pinned[0]!)) {
        const app = ps.some((p) => p.app && ready(p)) ? ' If the user would rather use the app\'s own browser for it (not signed in there as in their profile), call again with profile "app" once they say so.' : ''
        return { refused: `The address belongs to the browser profile "${pinned[0]!.label}", which is not open now. Do not use another profile instead; tell the user to open it.${app}`, why: 'pinned offline' }
      }
      return { profile: pinned[0]!, args }
    }
  }
  // a linked browser profile before the app's own browser: the person linked it to be used (the owner's bug: a desktop
  // turn never reached the Chrome that said "online")
  const open = ps.filter((p) => !p.app && ready(p))
  if (open.length === 1) return { profile: open[0]!, args }
  if (open.length > 1) return { refused: `Several browser profiles are open (${open.map((p) => `"${p.label}"`).join(', ')}): pass \`profile\` with the one whose account this step needs. If the task does not say which account, ${ask}.`, why: 'which one' }
  const app = ps.find((p) => p.app && ready(p))
  if (app) return { profile: app, args }
  return { refused: 'None of the user\'s browser profiles is open now. Tell the user to open that browser (Chrome, Edge or Brave with the extension connects by itself), or to check Settings › Browser.', why: 'none open' }
}
