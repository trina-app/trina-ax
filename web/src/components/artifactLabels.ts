// Translated names of the artifact types (cards in the chat and the artifact panel header).
import type { ArtifactType } from '@mycel/shared/api'
import type { MessageKey } from '../i18n'

export const TYPE_LABEL: Record<ArtifactType, MessageKey> = {
  html: 'artifact.type.html',
  react: 'artifact.type.react',
  svg: 'artifact.type.svg',
  mermaid: 'artifact.type.mermaid',
  markdown: 'artifact.type.markdown',
  code: 'artifact.type.code',
}
