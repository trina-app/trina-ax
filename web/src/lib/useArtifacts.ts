// Saved artifacts of a chat (GET /api/chats/:id/artifacts, versions without content) and one version's content
// (GET /api/artifacts/:id). Refetched when the chat store bumps artifactsRev (artifact.updated done, message.done).
import { useEffect, useState } from 'react'
import type { Artifact, ArtifactGroup } from '@mycel/shared/api'
import { api, API } from './api'
import { useChats } from '../store/chats'

const listCache = new Map<string, { rev: number; result: Promise<ArtifactGroup[]> }>()
const contentCache = new Map<string, Promise<Artifact>>()

export function useChatArtifacts(chatId: string | undefined): ArtifactGroup[] | null {
  const rev = useChats((s) => (chatId ? s.artifactsRev[chatId] ?? 0 : 0))
  const [list, setList] = useState<ArtifactGroup[] | null>(null)
  useEffect(() => {
    if (!chatId) {
      setList(null)
      return
    }
    let entry = listCache.get(chatId)
    if (!entry || entry.rev !== rev) {
      const result = api.call(API.listChatArtifacts, { params: { id: chatId } }).then((r) => r.items)
      listCache.set(chatId, (entry = { rev, result }))
      result.catch(() => listCache.delete(chatId))
    }
    let live = true
    entry.result.then((l) => live && setList(l), () => live && setList([]))
    return () => {
      live = false
    }
  }, [chatId, rev])
  return list
}

export function loadArtifact(id: string): Promise<Artifact> {
  let p = contentCache.get(id)
  if (!p) {
    p = api.call(API.getArtifact, { params: { id } })
    contentCache.set(id, p)
    p.catch(() => contentCache.delete(id))
  }
  return p
}

export function useArtifactContent(id: string | null | undefined): { artifact: Artifact | null; error: unknown } {
  const [state, setState] = useState<{ artifact: Artifact | null; error: unknown }>({ artifact: null, error: null })
  useEffect(() => {
    if (!id) {
      setState({ artifact: null, error: null })
      return
    }
    let live = true
    setState({ artifact: null, error: null })
    loadArtifact(id).then(
      (a) => live && setState({ artifact: a, error: null }),
      (e) => live && setState({ artifact: null, error: e }),
    )
    return () => {
      live = false
    }
  }, [id])
  return state
}
