// Source offer metadata, not a source exporter or an assertion of publication/content verification.
import { z } from 'zod'

export const SOURCE_CODE = {
  repository: 'https://github.com/trina-app/trina-ax',
  /** false while the repository is not public yet (review OSS-01): the link asks for the source by mail instead */
  published: false,
  requestEmail: 'support@treesoop.com',
  license: 'AGPL-3.0-only',
} as const

const SourceVersion = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$/)
const RequestEmail = z.string().max(254).email().refine(v => !/[\s,;?%<>]/.test(v), 'Use one plain mailbox')

/** A fixed operator URL. No credentials, query tokens, fragments, or ambiguous path decoding. Never fetched here. */
export function sourceDownloadUrl(value: string): boolean {
  if (value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false
  const match = /^https:\/\/[^/?#]+(\/[^?#]*)$/.exec(value)
  if (!match || !match[1] || match[1] === '/') return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false
    let pathname = match[1]
    for (let round = 0; round < 4; round++) {
      if (/[\u0000-\u0020\u007f\\]/.test(pathname) || pathname.split('/').some(p => p === '.' || p === '..')) return false
      const decoded = decodeURIComponent(pathname)
      if (decoded === pathname) return true
      pathname = decoded
    }
  } catch { /* malformed URL or escape */ }
  return false
}

export const SourceRelease = z.object({ version: SourceVersion, url: z.string().refine(sourceDownloadUrl, 'Use a fixed HTTPS source URL without credentials, query, fragment or traversal') }).strict()
export const SourceCodeConfig = z.object({ requestEmail: RequestEmail.optional(), release: SourceRelease.optional() }).strict()
export type SourceCodeConfig = z.infer<typeof SourceCodeConfig>
export const SourceCodeOffer = z.object({ requestEmail: RequestEmail, download: SourceRelease.nullable() })
export type SourceCodeOffer = z.infer<typeof SourceCodeOffer>

/** Version equality prevents a stale installed configuration from advertising another release after update/rollback.
 * The operator must separately approve the URL and verify its corresponding source; metadata proves neither. */
export function sourceCodeOffer(version: string | null | undefined, config?: SourceCodeConfig): SourceCodeOffer {
  const parsed = SourceCodeConfig.safeParse(config ?? {})
  const c = parsed.success ? parsed.data : {}
  return { requestEmail: c.requestEmail ?? SOURCE_CODE.requestEmail, download: c.release && SourceVersion.safeParse(version).success && c.release.version === version ? c.release : null }
}

/** The link for a version: its release tag (v<version>) once the repository is public, else a mail request. */
export function sourceCodeLink(version: string | null | undefined, src: { repository: string; published: boolean; requestEmail: string } = SOURCE_CODE): { href: string; kind: 'tag' | 'request' } {
  const v = SourceVersion.safeParse(version).success ? version : null
  if (src.published && v) return { href: `${src.repository}/tree/v${v}`, kind: 'tag' }
  const subject = encodeURIComponent(`Source code request (AGPL-3.0)${v ? `: version ${v}` : ''}`)
  return { href: `mailto:${src.requestEmail}?subject=${subject}`, kind: 'request' }
}
