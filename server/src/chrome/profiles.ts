// Which of the person's linked browser profiles a browser call goes to (docs/decisions/20261128-trina-in-chrome.md).
// One rule for the in-app AI (chat/tools.ts) and the person's own MCP apps (connectors/remote-mcp/browser.ts).
import { urlsOf } from '../realtime/browser-tools'
import { siteCovers } from './store'

export interface ChromeProfile { linkId: string; label: string; email: string | null; online: boolean; sites: string[]; onlyListed: boolean }

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
 * one does), else the only one open. A named or pinned profile that is not open is refused, never swapped for another.
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
    if (!ps.some((x) => x.linkId === asked) && byName.length > 1) return { refused: `Several browser profiles are named "${byName[0]!.label}": pass the id of the one you mean (${byName.map((x) => x.linkId).join(', ')}), or ask the user which account to use.`, why: 'same name' }
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
      if (!ready(pinned[0]!)) return { refused: `The address belongs to the browser profile "${pinned[0]!.label}", which is not open now. Do not use another profile instead; tell the user to open it.`, why: 'pinned offline' }
      return { profile: pinned[0]!, args }
    }
  }
  const open = ps.filter(ready)
  if (open.length === 1) return { profile: open[0]!, args }
  if (!open.length) return { refused: 'None of the user\'s browser profiles is open now. Tell the user to open their browser.', why: 'none open' }
  return { refused: `Several browser profiles are open (${open.map((p) => `"${p.label}"`).join(', ')}): pass \`profile\` with the one whose account this step needs. If the task does not say which account, ${ask}.`, why: 'which one' }
}
