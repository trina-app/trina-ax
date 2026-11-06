// Intro decks being built in a chat turn (docs/DECISIONS.md "D2", round 2), per chat: from the deck.progress events
// and, when a chat's messages load with intro_deck steps (only then: no request per chat that never made a deck), from
// GET /api/intro-decks/builds. An older picture of a build never replaces a newer one (lib/deckProgress.ts mergeBuild).
// When a build's outline comes on a computer the deck panel opens by itself, like a saved deck (store/chats.ts
// OPENS_BY_ITSELF); on a phone the chat's strip is enough and the finished deck opens as it always has. When a build is
// done while its chat is not on screen (another chat, another page): a toast with the cover and [열기], a dot on the
// chat in the sidebar until it is opened, and in the desktop app a system notification while its window is not focused.
import { create } from 'zustand'
import { DECK_ARTIFACT_KEY, DECK_TOOL, type DeckBuild } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { desktop } from '../lib/desktop'
import { doneDetail, mergeBuild, slideUrl } from '../lib/deckProgress'
import { navigateTo } from '../lib/nav'
import { t } from '../i18n'
import { useChats } from './chats'
import { toast } from './ui'

interface DeckBuildsState {
  /** chatId -> its builds, newest first */
  builds: Record<string, readonly DeckBuild[]>
  /** chats whose deck was finished while they were not on screen: a dot in the sidebar until opened */
  unseen: Record<string, true>
  handleEvent: (chatId: string, build: DeckBuild) => void
  load: (chatId: string) => Promise<void>
  /** the chat is on screen: its dot goes */
  seen: (chatId: string) => void
  /** after a reconnect the server could not resume: the builds of the chats asked for before, again */
  reloadAll: () => Promise<void>
  reset: () => void
}

/** chats whose builds were asked for (once per chat; a reconnect asks again) */
const asked = new Set<string>()
/** builds that opened the panel by themselves, and builds whose end was announced: each happens once */
const opened = new Set<string>()
const announced = new Set<string>()
const remember = (set: Set<string>, id: string) => {
  set.add(id)
  if (set.size > 200) set.delete(set.values().next().value!)
}
let generation = 0

const phone = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767.98px)').matches
const onScreen = (chatId: string) => typeof location !== 'undefined' && location.pathname === `/c/${chatId}`
const finished = (b: DeckBuild) => b.phase === 'done' || b.phase === 'failed'

/** [열기] on the toast: that chat, with the deck beside it (Layout opens it once the chat is on screen). */
export function openDeckChat(chatId: string) {
  useChats.setState({ autoOpen: { chatId, key: DECK_ARTIFACT_KEY, at: Date.now() } })
  navigateTo(`/c/${chatId}`)
}

export const useDeckBuilds = create<DeckBuildsState>((set, get) => {
  /** The deck is done: say so where the person is (not in the chat on screen, which shows it), and in the desktop app's
   * notifications while its window is not focused (the desktop app shows them only then). */
  const announce = (chatId: string, b: DeckBuild) => {
    if (announced.has(b.id)) return
    remember(announced, b.id)
    const detail = doneDetail(b, t)
    if (!onScreen(chatId)) {
      set((s) => ({ unseen: { ...s.unseen, [chatId]: true } }))
      toast({
        level: 'info',
        text: t('deck.progress.ready'),
        detail,
        image: b.thumbs && b.slides[0]?.status === 'done' ? slideUrl(b, 0) : undefined,
        ms: 10_000,
        action: { label: t('deck.progress.open'), primary: true, run: () => openDeckChat(chatId) },
      })
    }
    if (typeof document !== 'undefined' && !document.hasFocus?.()) desktop()?.notify({ title: t('deck.progress.ready'), body: `${b.title} · ${detail}`, tag: `deck-${b.id}` })
  }

  const put = (chatId: string, b: DeckBuild) => {
    const list = get().builds[chatId] ?? []
    const next = mergeBuild(list, b)
    if (next === list) return null
    set((s) => ({ builds: { ...s.builds, [chatId]: next } }))
    return list.find((x) => x.id === b.id) ?? null
  }

  return {
    builds: {},
    unseen: {},

    handleEvent(chatId, build) {
      const known = get().builds[chatId]?.some((x) => x.id === build.id) ?? false
      const before = put(chatId, build)
      if (!before && known) return // an older picture than the one we have
      // the outline has just come (the first event with the planned slides; the longer budgets send events while they
      // read the material first): the panel opens beside the chat on a computer (the deck is the whole answer). A build
      // already listed with its outline (the page opened again while it is made) does not open it.
      if (build.outlineAt && !before?.outlineAt && !opened.has(build.id) && !finished(build)) {
        remember(opened, build.id)
        if (!phone()) useChats.setState((s) => ({ autoOpen: { chatId, key: DECK_ARTIFACT_KEY, at: Date.now() }, buildOpened: { ...s.buildOpened, [chatId]: build.messageId ?? build.id } }))
      }
      if (build.phase === 'done' && before?.phase !== 'done') announce(chatId, build)
    },

    async load(chatId) {
      asked.add(chatId)
      const session = generation
      try {
        const r = await api.call(API.listDeckBuilds, { query: { chatId } })
        if (session !== generation) return
        for (const b of r.builds) put(chatId, b)
      } catch {
        // no list (an older server, the network): the events still come
        if (session === generation) asked.delete(chatId)
      }
    },

    seen(chatId) {
      if (!get().unseen[chatId]) return
      set((s) => {
        const unseen = { ...s.unseen }
        delete unseen[chatId]
        return { unseen }
      })
    },

    async reloadAll() {
      await Promise.allSettled([...asked].map((id) => get().load(id)))
    },

    reset() {
      generation++
      asked.clear()
      opened.clear()
      announced.clear()
      set({ builds: {}, unseen: {} })
    },
  }
})

/** A chat's messages loaded or changed: its builds are asked for once it shows a step of the deck tool. */
const wantsBuilds = (chatId: string) => !asked.has(chatId) && (useChats.getState().threads[chatId]?.messages.some((m) => m.steps?.some((s) => s.tool === DECK_TOOL)) ?? false)
useChats.subscribe((s, prev) => {
  if (s.threads === prev.threads) return
  for (const chatId of Object.keys(s.threads)) if (s.threads[chatId] !== prev.threads[chatId] && wantsBuilds(chatId)) void useDeckBuilds.getState().load(chatId)
})

/** The newest build of a chat, and the one an answer made. */
export const useNewestBuild = (chatId: string) => useDeckBuilds((s) => s.builds[chatId]?.[0] ?? null)
export const useMessageBuild = (chatId: string, messageId: string) => useDeckBuilds((s) => s.builds[chatId]?.find((b) => b.messageId === messageId) ?? null)
