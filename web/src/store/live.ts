// Wires the WebSocket to the stores: one RealtimeClient per signed-in window.
import type { FileChange, Memory, ServerEvent } from '@mycel/shared/api'
import { renewWindowId, windowId } from '../lib/api'
import { BrowserRelay } from '../lib/browserRelay'
import { openTeamFile } from '../lib/sidePanel'
import { Emitter } from '../lib/emitter'
import { defaultWsBase, RealtimeClient, type ConnState } from '../lib/realtime'
import { t } from '../i18n'
import { useChats } from './chats'
import { useEngines } from './engines'
import { useJobs } from './jobs'
import { useSession } from './session'
import { toast, useUi } from './ui'

/** files.changed (only paths this person can read): the file screen refreshes the folder it shows. */
export const filesChanged = new Emitter<FileChange[]>()
export const memoryChanged = new Emitter<{ change: 'created' | 'deleted' | 'cleared'; memory: Memory | null }>()
/** an admin changed folder rules, groups or roles in a way that changes what this person sees (tab 5 "권한 회수") */
export const accessChanged = new Emitter<void>()
/** the server could not resume us: screens that hold REST data reload it */
export const reloadAsked = new Emitter<'reset' | 'resync'>()

let client: RealtimeClient | null = null
let relay: BrowserRelay | null = null
let firstServerVersion: string | null = null

export function dispatch(ev: ServerEvent) {
  if (ev.type === 'message.done' && typeof document !== 'undefined' && document.hidden) {
    useUi.getState().setUnseenDone(useUi.getState().unseenDone + 1)
  }
  switch (ev.type) {
    case 'message.created':
    case 'message.delta':
    case 'message.step':
    case 'message.done':
    case 'queue.position':
    case 'chat.updated':
    case 'turn.request':
    case 'turn.request.closed':
    case 'artifact.updated':
      useChats.getState().handleEvent(ev)
      return
    case 'files.changed':
      filesChanged.emit(ev.data.changes)
      return
    case 'files.conflict': {
      // a save met a newer version (mine or someone else's): both people hear about the conflict copy
      const copy = ev.data.copyPath
      toast({ level: 'warn', text: t('files.conflictNotice', { path: ev.data.path, copy, by: ev.data.by?.name ?? '' }), sticky: true, action: { label: t('files.openCopy'), run: () => openTeamFile(copy) } })
      return
    }
    case 'job.progress':
      useJobs.getState().progress(ev.data.jobId, ev.data.kind, ev.data.progress, ev.data.message)
      return
    case 'job.done':
      useJobs.getState().done(ev.data.job)
      return
    case 'memory.changed':
      memoryChanged.emit(ev.data)
      return
    case 'notice':
      if (ev.data.code === 'engine_choice_changed') {
        // the admin changed who may pick the engine or which engines are on: show / hide the picker without a reload
        void useSession.getState().refreshMe()
        void useEngines.getState().load(true)
        return
      }
      if (ev.data.code === 'locale_changed') {
        // the team default or this person's language changed (admin, another window): switch without a reload
        void useSession.getState().refreshMe()
        return
      }
      if (ev.data.code === 'access_changed') {
        // the server sends the folders whose access changed as data ("groups/finance, shared"), not a sentence
        toast({ level: 'info', text: t('notice.accessChanged', { paths: ev.data.message }) })
        accessChanged.emit()
        return
      }
      toast({ level: ev.data.level, text: ev.data.message, sticky: ev.data.level === 'error' })
      return
    case 'browser.call':
      relay?.handleCall(ev.data.call)
      return
    case 'browser.cancel':
      relay?.cancel(ev.data.callId)
      return
    case 'session.ended':
      // after the person's own sign-out in this window the event (or the 4401 close) can still arrive: keep that screen
      if (useSession.getState().status.kind === 'signed-in') useSession.getState().signedOut('ended')
      return
  }
}

export function startLive() {
  if (client) return
  client = new RealtimeClient({
    baseUrl: defaultWsBase(),
    windowId,
    renewWindowId,
    createSocket: (url, protocols) => new WebSocket(url, protocols) as never,
    onEvent: dispatch,
    onReload: (reason) => {
      void useChats.getState().reloadAll()
      void useSession.getState().refreshMe() // a language change may have happened while we were away
      reloadAsked.emit(reason)
    },
    onState: (s: ConnState) => {
      useUi.getState().setConn(s)
      // session.ended (handled above) comes before the close and already says why
      if (s === 'signed-out' && useSession.getState().status.kind === 'signed-in') useSession.getState().signedOut('expired')
    },
    onHello: ({ serverVersion }) => {
      if (firstServerVersion === null) firstServerVersion = serverVersion
      else if (serverVersion !== firstServerVersion) {
        useUi.getState().setUpdateReady(true)
        toast({ level: 'info', text: t('update.ready'), sticky: true, action: { label: t('update.reload'), run: () => location.reload() } })
      }
    },
  })
  relay = new BrowserRelay((f) => client?.send(f))
  client.start()
  window.addEventListener('online', nudge)
  document.addEventListener('visibilitychange', onVisible)
}

const nudge = () => client?.nudge()
const onVisible = () => document.visibilityState === 'visible' && client?.nudge()

export function stopLive() {
  client?.stop()
  client = null
  relay = null
  window.removeEventListener('online', nudge)
  document.removeEventListener('visibilitychange', onVisible)
}
