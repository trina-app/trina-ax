// Text fixes before an answer's Markdown is rendered (no DOM, no network; test/unit/markdown.test.ts).
// Ported from Saram web/src/lib/markdown.ts.
import remend from 'remend'

// $…$ is math when (as in pandoc) the opening $ is followed and the closing $ preceded by a non-space, and the closing
// $ is not followed by a digit: "$1$", "$x^2$" are math; "$5 coupon and $10 off" is not.
/** Escape the dollars of prices ("$5"), spreadsheet refs ("$A$1") and env vars ("$PATH") outside math. */
function guardLine(line: string) {
  return line
    .split(/(\$\$[\s\S]*?\$\$|\$(?=\S)(?:[^$\n\\]|\\.)*?\S\$(?!\d)|\$[^\s$]\$(?!\d))/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/(?<!\\)\$([A-Z]{1,3})\$(\d+)/g, '\\$$$1\\$$$2')
            .replace(/(?<![\\$\w])\$(?=\d)/g, '\\$')
            .replace(/(?<![\\$\w])\$([A-Z_][A-Z0-9_]{1,})\b/g, '\\$$$1'),
    )
    .join('')
}

/**
 * Single-dollar math on, without eating prices; code spans and fences are left alone. While streaming, close what is
 * still open (bold, a code fence, a link…) so the half-written answer doesn't flash raw markdown.
 */
export function prepareMarkdown(text: string, streaming?: boolean) {
  const guarded = text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.split('\n').map(guardLine).join('\n')))
    .join('')
  return streaming ? remend(guarded, { linkMode: 'text-only' }) : guarded
}

export type LinkKind =
  | { kind: 'team-file'; path: string }
  | { kind: 'external'; href: string }
  | { kind: 'app'; href: string }
  | { kind: 'blocked' }

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/**
 * What a link in an answer points to. Team files (/api/files/download?path=…) open in the preview panel; other
 * same-origin paths stay in the app; http(s)/mailto/tel open in a new tab; anything else (javascript:, data:, file:)
 * is not a link.
 */
export function classifyLink(href: string | undefined, origin: string): LinkKind {
  if (!href) return { kind: 'blocked' }
  let u: URL
  try { u = new URL(href, origin) } catch { return { kind: 'blocked' } }
  if (u.origin === origin) {
    if (u.pathname === '/api/files/download') {
      const path = u.searchParams.get('path')
      return path ? { kind: 'team-file', path } : { kind: 'blocked' }
    }
    if (u.pathname.startsWith('/api/')) return { kind: 'blocked' }
    return { kind: 'app', href: u.pathname + u.search + u.hash }
  }
  return SAFE_SCHEMES.has(u.protocol) ? { kind: 'external', href: u.href } : { kind: 'blocked' }
}

export type ImageKind = { kind: 'team-file'; path: string } | { kind: 'attachment-thumb'; url: string } | { kind: 'inline-data'; src: string } | { kind: 'external'; href: string; host: string } | { kind: 'blocked' }

const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/

/**
 * Images in answers (tab 5 "답변 표시 보안"): team-server images load; external images never load by themselves (a
 * URL can carry data out), the person opens them in a new tab. Inline data: images only as png/jpeg/gif/webp.
 */
export function classifyImage(src: string | undefined, origin: string): ImageKind {
  if (!src) return { kind: 'blocked' }
  if (src.startsWith('data:')) return IMAGE_DATA.test(src) ? { kind: 'inline-data', src } : { kind: 'blocked' }
  let u: URL
  try { u = new URL(src, origin) } catch { return { kind: 'blocked' } }
  if (u.origin === origin) {
    if (u.pathname === '/api/files/download' && u.searchParams.get('path')) return { kind: 'team-file', path: u.searchParams.get('path')! }
    if (/^\/api\/uploads\/[0-9a-f-]+\/thumbnail$/.test(u.pathname)) return { kind: 'attachment-thumb', url: u.pathname }
    return { kind: 'blocked' }
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'external', href: u.href, host: u.host }
  return { kind: 'blocked' }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
/** Team-server images shown directly: png/jpeg/gif/webp; SVG only through <img> (scripts never run there). */
export const isDisplayableImagePath = (path: string) => IMAGE_EXT.test(path) || /\.svg$/i.test(path)
