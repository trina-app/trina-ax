// Artifacts of a chat (versions grouped by key). Owner: C (server/src/routes/artifacts.ts).
import { z } from 'zod'
import { Artifact, ArtifactSummary } from './entities'
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
