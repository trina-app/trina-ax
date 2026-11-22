// Artifacts of a chat (versions grouped by key). Owner: C (server/src/routes/artifacts.ts).
import { z } from 'zod'
import { Artifact, ArtifactSummary, type ArtifactType } from './entities'
import { endpoint } from './endpoint'

export const ArtifactGroup = z.object({
  key: z.string(),
  /** newest first */
  versions: z.array(ArtifactSummary),
})
export type ArtifactGroup = z.infer<typeof ArtifactGroup>
export const ChatArtifacts = z.object({ items: z.array(ArtifactGroup) })

export const ARTIFACTS = {
  listChatArtifacts: endpoint({ method: 'GET', path: '/api/chats/:id/artifacts', auth: 'user', owner: 'C', response: ChatArtifacts, summary: 'Artifacts of an own chat, all versions, without content.' }),
  getArtifact: endpoint({ method: 'GET', path: '/api/artifacts/:id', auth: 'user', owner: 'C', response: Artifact, summary: 'One artifact version with content (own chats only).' }),
} as const

const EXT: Record<ArtifactType, string> = { html: 'html', react: 'jsx', svg: 'svg', mermaid: 'mmd', markdown: 'md', code: 'txt' }
const LANG_EXT: Record<string, string> = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx', shell: 'sh', bash: 'sh', sh: 'sh', zsh: 'sh',
  sql: 'sql', json: 'json', yaml: 'yml', yml: 'yml', html: 'html', css: 'css', go: 'go', rust: 'rs', java: 'java', kotlin: 'kt', swift: 'swift',
  c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', 'c#': 'cs', ruby: 'rb', php: 'php', markdown: 'md', xml: 'xml', toml: 'toml', r: 'r',
}

/** File name of an artifact for a download, "save to the team folder" (web ArtifactPanel) and the copy that goes with an
 * answer sent to a room (server chat/answer-share.ts): html→.html, react→.jsx, svg→.svg, mermaid→.mmd, markdown→.md,
 * code→its language's extension. */
export function artifactFileName(a: { key: string; title: string | null; type: ArtifactType; language: string | null }): string {
  const base = (a.title || a.key).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 100) || 'artifact'
  if (a.type === 'code') {
    const l = (a.language ?? '').toLowerCase()
    return `${base}.${LANG_EXT[l] ?? (/^[a-z0-9]{1,8}$/.test(l) ? l : 'txt')}`
  }
  return `${base}.${EXT[a.type]}`
}
