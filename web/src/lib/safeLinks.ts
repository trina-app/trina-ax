// Links inside documents drawn into the page (Word, PowerPoint, Excel previews; tab 5 "파일 응답 규칙"): a file can
// carry any link target (javascript:, data:, file:, a relative path into this app). After rendering, only absolute
// http(s) links keep their address, and a click on one asks first and opens a new window without an opener. Links
// inside the document (#bookmark) scroll within the preview. Everything else stops being a link.

const XLINK = 'http://www.w3.org/1999/xlink'

/** The address of a link a document may open: absolute http(s) only. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null
  const v = href.trim()
  if (!/^https?:\/\//i.test(v)) return null
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

const rawHref = (a: Element) => a.getAttribute('href') ?? a.getAttributeNS(XLINK, 'href')

const REL = 'noopener noreferrer nofollow'

/**
 * Strip every link under `root` that is not http(s) or an in-document #anchor; make the rest open safely. Only
 * touches what needs changing, so running it again (from a MutationObserver) changes nothing.
 */
export function sanitizeLinks(root: ParentNode) {
  for (const a of root.querySelectorAll('a, area')) {
    const raw = rawHref(a)
    const anchor = raw !== null && raw.startsWith('#')
    const safe = anchor ? null : safeHref(raw)
    if (a.hasAttributeNS(XLINK, 'href') && !(anchor && a.getAttribute('href') === null)) a.removeAttributeNS(XLINK, 'href')
    if (a.hasAttribute('target')) a.removeAttribute('target')
    if (a.hasAttribute('ping')) a.removeAttribute('ping')
    if (anchor) continue
    if (safe) {
      if (a.getAttribute('href') !== safe) a.setAttribute('href', safe)
      if (a.getAttribute('rel') !== REL) a.setAttribute('rel', REL)
    } else if (a.hasAttribute('href')) a.removeAttribute('href')
  }
  // forms in a drawn document would post to this server with the person's cookie
  for (const f of root.querySelectorAll('form[action]')) f.removeAttribute('action')
}

/**
 * Keep `el` safe while a library draws into it (some draw lazily): sanitize now and on every change, and handle
 * clicks on links before the document's own handlers. Returns the cleanup.
 */
export function guardLinks(el: HTMLElement, confirmOpen: (url: string) => boolean, open: (url: string) => void = openExternal): () => void {
  sanitizeLinks(el)
  const mo = new MutationObserver(() => sanitizeLinks(el))
  mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'xlink:href', 'action', 'target'] })
  const onClick = (e: MouseEvent) => {
    const target = e.target as Element | null
    const a = target?.closest?.('a, area')
    if (!a || !el.contains(a)) return
    e.preventDefault()
    e.stopPropagation()
    const raw = rawHref(a)
    if (raw?.startsWith('#')) {
      const id = decodeURIComponent(raw.slice(1))
      const dest = !id ? undefined : [...el.querySelectorAll('[id], a[name]')].find((n) => n.id === id || n.getAttribute('name') === id)
      dest?.scrollIntoView({ block: 'start' })
      return
    }
    const safe = safeHref(raw)
    if (safe && confirmOpen(safe)) open(safe)
  }
  el.addEventListener('click', onClick, true)
  el.addEventListener('auxclick', onClick, true)
  return () => {
    mo.disconnect()
    el.removeEventListener('click', onClick, true)
    el.removeEventListener('auxclick', onClick, true)
  }
}

export function openExternal(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}
