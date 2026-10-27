// Where the source code of the running version is (AGPL-3.0 §13: people who use the server over the network can get
// the source of the version they use; review OSS-02, control-plane SV-8). The web app links to it from Settings >
// About and below the sign-in form.
export const SOURCE_CODE = {
  repository: 'https://github.com/potenlab/team-ax',
  /** false while the repository is not public yet (review OSS-01): the link asks for the source by mail instead */
  published: false,
  requestEmail: 'support@treesoop.com',
  license: 'AGPL-3.0-only',
} as const

/** The link for a version: its release tag (v<version>) once the repository is public, else a mail request. */
export function sourceCodeLink(version: string | null | undefined, src: { repository: string; published: boolean; requestEmail: string } = SOURCE_CODE): { href: string; kind: 'tag' | 'request' } {
  const v = version && /^[0-9A-Za-z.+-]{1,40}$/.test(version) ? version : null
  if (src.published) return { href: v ? `${src.repository}/tree/v${v}` : src.repository, kind: 'tag' }
  const subject = encodeURIComponent(`Source code request (AGPL-3.0)${v ? `: version ${v}` : ''}`)
  return { href: `mailto:${src.requestEmail}?subject=${subject}`, kind: 'request' }
}
