// "프로젝트 사람들과 공유" (shared/src/api/chats.ts shareChat; docs/DECISIONS.md "Shared project chats", "An existing chat
// shared"): my private chat in a team project that shares its chats becomes a shared chat. The flow starts from the
// move dialog's switch (components/chat/ChatProject.tsx) or the title menu (components/chat/ChatTitleMenu.tsx). The
// server checks what the chat used, every branch: when nothing is narrower than the project's people, it is shared at
// once; otherwise it answers "confirm" and one dialog asks, in the style of "대화방에 보내기"'s provenance line
// (components/chat/ShareToRoom.tsx): first the sentence that the whole conversation shows and that sharing cannot be
// undone, then how many people cannot see material it used and the places I may look myself (never who), "not all
// known" for an older chat, and a note when personal memories may be in it. 공유하기 (the focused default) sends the key
// back; something changed meanwhile: it asks again, said so on top. 취소, ✕ and Esc leave the chat as it is (moved, when
// it was just moved, and private). Shared: a toast, and the chat everywhere gets its shared mark (store/chats.ts).
import { AlertCircle, Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Chat, Project, ShareChatResult } from '@mycel/shared/api'
import { useLocale, useT } from '../../i18n'
import { api, API, errorText } from '../../lib/api'
import { sharesNewChats } from '../../lib/sharedChat'
import { useChats } from '../../store/chats'
import { toast } from '../../store/ui'
import { Button, Modal } from '../ui'
import { placeName } from './ShareToRoom'

type Ask = Extract<ShareChatResult, { status: 'confirm' }> & { seq: number }

/** May this person offer to share this chat: a chat of one person (so theirs), not confidential, in a project whose new
 * chats are shared (a team project, its setting on, its folder not in the trash, safe operations off). The server
 * checks all of it again, and what the screens cannot know (a scheduled run's chat, a busy one). */
export const mayShareChat = (chat: Partial<Pick<Chat, 'shared' | 'confidential' | 'deletedAt'>>, project: Pick<Project, 'shareChats' | 'inTrash'> | null | undefined, safeOps: boolean): boolean =>
  !chat.shared && !chat.confidential && !chat.deletedAt && sharesNewChats(project, safeOps)

/** The share of `chatId`: asks the server at once, and shows the confirm when one comes back. `onShared`: the chat as
 * shared (it is also put in the chat list); `onClose`: the flow is over, shared or not. */
export function ShareChatFlow({ chatId, onClose, onShared }: { chatId: string; onClose: () => void; onShared?: (c: Chat) => void }) {
  const t = useT()
  const locale = useLocale()
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState(false)
  const started = useRef(false)

  const run = async (confirmKey?: string) => {
    setBusy(true)
    try {
      const r = await api.call(API.shareChat, { params: { id: chatId }, body: confirmKey ? { confirmKey } : {} })
      if (r.status === 'confirm') {
        setAsk((a) => ({ ...r, seq: (a?.seq ?? 0) + 1 }))
        setBusy(false)
        return
      }
      useChats.getState().upsertChat(r.chat)
      onShared?.(r.chat)
      toast({ level: 'success', text: t('chat.shareChat.done') })
      onClose()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      onClose()
    }
  }
  useEffect(() => {
    if (started.current) return
    started.current = true
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!ask) return null
  const p = ask.provenance
  const places = p?.places.map((x) => placeName(t, x)) ?? []
  const line = !p ? null : p.unknown ? t('chat.shareChat.unknown') : places.length ? t('chat.shareChat.provenance', { m: p.people, places: places.join(', ') }) : t('chat.shareChat.provenanceNoPlace', { m: p.people })
  // each ask is a dialog of its own (key): it opens with the focus on 공유하기
  return (
    <Modal
      key={`share-chat-${ask.seq}`}
      open
      onClose={onClose}
      width={460}
      title={t('chat.shareChat.title', { n: ask.audience })}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose} data-testid="share-chat-cancel">
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void run(ask.confirmKey)} data-autofocus data-testid="share-chat-confirm">
            {t('chat.shareChat.share')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="share-chat-ask">
        {ask.reason === 'changed' && (
          <p role="status" className="flex items-start gap-2 text-sm leading-6 break-keep text-warn" data-testid="share-chat-changed">
            <AlertCircle size={16} className="mt-1 shrink-0" aria-hidden />
            {t('chat.shareChat.changed')}
          </p>
        )}
        <p className="text-sm leading-6 break-keep text-muted" data-testid="share-chat-note">
          {t('chat.shareChat.note')}
        </p>
        {line && (
          <p className="flex items-start gap-2 text-sm leading-6 break-keep text-ink" data-testid="share-chat-provenance">
            <Info size={16} className="mt-1 shrink-0 text-faint" aria-hidden />
            <span>{line}</span>
          </p>
        )}
        {ask.memories && (
          <p className="flex items-start gap-2 text-sm leading-6 break-keep text-ink" data-testid="share-chat-memories">
            <Info size={16} className="mt-1 shrink-0 text-faint" aria-hidden />
            <span>{t('chat.shareChat.memories')}</span>
          </p>
        )}
      </div>
    </Modal>
  )
}
