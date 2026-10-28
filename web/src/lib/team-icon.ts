// The tab icon: the team's logo (Admin › Team settings) or the default mark (shared/src/team-icon.ts). The server
// already writes the right links into index.html; after sign-in, and when an admin changes the logo (realtime notice
// team_icon_changed → GET /api/me again), this keeps the open page's links in step.
import { checkTeamIcon, iconLinks, isTeamIconType, TEAM_ICON_MAX_BYTES, type IconLink, type TeamIconProblem, type TeamIconType } from '@mycel/shared'

const SELECTOR = 'link[rel="icon"], link[rel="apple-touch-icon"]'

const same = (a: IconLink, b: IconLink) => a.rel === b.rel && a.href === b.href && (a.type ?? '') === (b.type ?? '') && (a.sizes ?? '') === (b.sizes ?? '')

/** The links the page should have for this version, or null when it has them already (nothing to touch). */
export function nextIconLinks(current: IconLink[], version: string | null | undefined): IconLink[] | null {
  // an older server says nothing about the logo: leave what index.html came with
  if (version === undefined) return null
  const want = iconLinks(version)
  return current.length === want.length && current.every((l, i) => same(l, want[i]!)) ? null : want
}

const linkOf = (el: HTMLLinkElement): IconLink => ({
  rel: el.getAttribute('rel') as IconLink['rel'],
  href: el.getAttribute('href') ?? '',
  ...(el.getAttribute('type') ? { type: el.getAttribute('type')! } : {}),
  ...(el.getAttribute('sizes') ? { sizes: el.getAttribute('sizes')! } : {}),
})

/** Point the page's icon links at the logo (or back at the default mark). True when they changed. */
export function applyTeamIcon(version: string | null | undefined, doc: Document | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  if (!doc?.head) return false
  const have = [...doc.head.querySelectorAll<HTMLLinkElement>(SELECTOR)]
  const want = nextIconLinks(have.map(linkOf), version)
  if (!want) return false
  // new elements, not new hrefs on the old ones: browsers re-read the tab icon when the links are replaced
  const anchor = have[0] ?? doc.head.querySelector('link[rel="manifest"]')
  for (const l of want) {
    const el = doc.createElement('link')
    el.setAttribute('rel', l.rel)
    if (l.type) el.setAttribute('type', l.type)
    if (l.sizes) el.setAttribute('sizes', l.sizes)
    el.setAttribute('href', l.href)
    doc.head.insertBefore(el, anchor)
  }
  for (const el of have) el.remove()
  return true
}

/**
 * The same checks the server makes, before uploading (the server's are the ones that count): the type the browser
 * gives the file, its size, its first bytes and its pixel size.
 */
export async function checkIconFile(file: Blob): Promise<{ ok: true; type: TeamIconType; width: number; height: number } | { ok: false; problem: TeamIconProblem }> {
  if (!isTeamIconType(file.type)) return { ok: false, problem: 'type' }
  if (file.size > TEAM_ICON_MAX_BYTES) return { ok: false, problem: 'too_big' }
  return checkTeamIcon(new Uint8Array(await file.arrayBuffer()), file.type)
}
