// Wires the WebSocket to the stores: one RealtimeClient per signed-in window.
import type { CredentialLogin, FileChange, Memory, ServerEvent } from '@mycel/shared/api'
import { renewWindowId, windowId } from '../lib/api'
import { BrowserRelay } from '../lib/browserRelay'
import { browserSettingsBridge } from '../lib/desktop'
import { openTeamFile } from '../lib/sidePanel'
import { navigateTo } from '../lib/nav'
import { keepUnsentAsDrafts } from '../lib/reload-guard'
import { Emitter } from '../lib/emitter'
import { defaultWsBase, RealtimeClient, type ConnState } from '../lib/realtime'
import { t } from '../i18n'
import { useChats } from './chats'
import { useDeckBuilds } from './deckBuilds'
import { useAiAccess } from './aiAccess'
import { useEngines } from './engines'
import { useJobs } from './jobs'
import { usePeople } from './people'
import { useRooms } from './rooms'
import { roomMessageSound, startRoomSound, stopRoomSound } from './roomSound'
import { useSession } from './session'
import { chatUpdated, roomMessage, roomUpdated, startSessionMarkers, stopSessionMarkers } from './sessionMarkers'
import { toast, useUi } from './ui'

/** files.changed (only paths this person can read): the file screen refreshes the folder it shows. */
export const filesChanged = new Emitter<FileChange[]>()
export const memoryChanged = new Emitter<{ change: 'created' | 'updated' | 'deleted' | 'cleared'; memory: Memory | null }>()
/** an admin changed folder rules, groups or roles in a way that changes what this person sees (tab 5 "권한 회수") */
export const accessChanged = new Emitter<void>()
/** a team skill changed, was suggested or reviewed: the team skills screen and the sidebar count reload */
export const skillsChanged = new Emitter<void>()
/** Metadata-only inbox/preferences changed in this person's account. */
export const notificationsChanged = new Emitter<void>()
/** this window changed a scheduled task (resumed one from its card): the "paused for review" banner recounts */
export const schedulesChanged = new Emitter<void>()
/** a ChatGPT sign-in this person started (Admin / Settings > AI providers): its address, code and result */
export const credentialLogin = new Emitter<CredentialLogin>()
/** the server could not resume us: screens that hold REST data reload it */
export const reloadAsked = new Emitter<'reset' | 'resync'>()
/** an answer of this chat took a step or ended (message.step / message.done), also for a chat no screen has open: the
 * company profile step asks for its draft's pages right away instead of at its next poll */
export const chatActivity = new Emitter<string>()

let client: RealtimeClient | null = null
let relay: BrowserRelay | null = null
let firstServerVersion: string | null = null

/** replay: the server sent it again after a reconnect (lib/realtime.ts); it is applied, but nothing rings for it */
export function dispatch(ev: ServerEvent, meta: { replay: boolean } = { replay: false }) {
  if (ev.type === 'message.step' || ev.type === 'message.done') chatActivity.emit(ev.data.chatId)
  switch (ev.type) {
    case 'queue.position':
      // a question to the AI in a room waits in the same queue (store/rooms.ts keeps the room's own)
      useRooms.getState().handleEvent(ev)
      useChats.getState().handleEvent(ev)
      return
    case 'chat.updated':
      // session markers (store/sessionMarkers.ts): a live change worth it is told, after a wait
      chatUpdated(ev, meta)
      useChats.getState().handleEvent(ev)
      return
    case 'message.created':
    case 'message.delta':
    case 'message.step':
    case 'message.done':
    case 'turn.request':
    case 'turn.request.closed':
    case 'artifact.updated':
      useChats.getState().handleEvent(ev)
      return
    case 'deck.progress':
      // an intro deck being built (docs/DECISIONS.md "D2", round 2): the chat's block and the panel (its end is told
      // like any answer's: session markers)
      useDeckBuilds.getState().handleEvent(ev.data.chatId, ev.data.build)
      return
    case 'files.changed':
      filesChanged.emit(ev.data.changes)
      return
    case 'room.message':
      // a message the server gave me a notice of: told in the desktop app like the Inbox and push (store/sessionMarkers.ts)
      roomMessage(ev, meta)
      useRooms.getState().handleEvent(ev)
      // a new message meant for me rings once on this device (store/roomSound.ts); an edit or a delete never does
      roomMessageSound(ev.data.roomId, ev.data.message, meta.replay)
      return
    case 'room.updated':
      // the room's AI waits on me now (Room.aiWaits): told like a card
      roomUpdated(ev, meta)
      useRooms.getState().handleEvent(ev)
      return
    case 'room.message.updated':
    case 'room.read':
    case 'room.thread':
    // a reaction never rings (nor counts anywhere)
    case 'room.reactions':
    case 'room.ai':
    case 'room.ai.run':
    case 'room.ai.step':
      // the team chat rooms (store/rooms.ts): only the room's members get these
      useRooms.getState().handleEvent(ev)
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
    case 'credential.login':
      credentialLogin.emit(ev.data)
      return
    case 'notice':
      if (ev.data.code === 'notifications.changed') {
        notificationsChanged.emit()
        return
      }
      if (ev.data.code === 'room_alerts_changed') {
        // my notification settings changed (here or on another device): every room's level and my quiet hours come with
        // the rooms list (the bell, the sound, the muted marks follow)
        void useRooms.getState().loadRooms()
        return
      }
      if (ev.data.code === 'engine_choice_changed') {
        // the admin changed who may pick the engine or which engines are on: show / hide the picker without a reload
        void useSession.getState().refreshMe()
        void useEngines.getState().load(true)
        // an AI connection was added or lost: the "no AI" banner follows
        void useAiAccess.getState().load(true)
        return
      }
      if (ev.data.code === 'browser_policy_changed') {
        // an admin changed whether people may turn on "Allow all websites": Settings > Browser follows, and the desktop
        // app re-reads the policy from the team server itself when the setting is read (it never takes it from here)
        void useSession.getState().refreshMe()
        void browserSettingsBridge()?.get().catch(() => null)
        return
      }
      if (ev.data.code === 'team_icon_changed') {
        // an admin set or removed the team logo: the sidebar header follows (GET /api/me carries its version); the tab
        // icon stays the product's
        void useSession.getState().refreshMe()
        return
      }
      if (ev.data.code === 'profile_changed' || ev.data.code === 'my_profile_changed') {
        // someone changed their name, title, status or photo (routes/people.ts): the people list (when a screen has read
        // it) follows, and my own account when it was me (another window or device), quietly: the notice carries no text
        if (ev.data.code === 'my_profile_changed') void useSession.getState().refreshMe()
        if (usePeople.getState().loaded) void usePeople.getState().load(true)
        return
      }
      if (ev.data.code === 'speech_changed') {
        // an admin turned voice input on or off: the composer shows or hides the mic (Me.team.voiceInput)
        void useSession.getState().refreshMe()
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
      if (ev.data.link) {
        // team skills: a change (owner and admins: open its version history), a suggestion to review, a review result
        const link = ev.data.link
        const label = ev.data.code === 'skill_changed' ? (link.startsWith('/trash') ? t('notice.open') : t('notice.openHistory')) : ev.data.code.startsWith('skill_') ? t('notice.openSkills') : t('notice.open')
        if (ev.data.code.startsWith('skill_')) skillsChanged.emit()
        // not sticky: it would sit over the composer; the same changes and suggestions stay on the 팀 스킬 screen
        toast({ level: ev.data.level, text: ev.data.message, action: { label, run: () => navigateTo(link) } })
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
      void useDeckBuilds.getState().reloadAll()
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
        toast({ level: 'info', text: t('update.ready'), sticky: true, action: { label: t('update.reload'), run: () => { keepUnsentAsDrafts(); location.reload() } } })
      }
    },
  })
  relay = new BrowserRelay((f) => client?.send(f))
  client.start()
  // neither the session markers nor the room sound ever stop the live updates
  try { startSessionMarkers() } catch { /* no markers' extras in this window */ }
  try { startRoomSound() } catch { /* no sound in this window */ }
  window.addEventListener('online', nudge)
  document.addEventListener('visibilitychange', onVisible)
}

const nudge = () => client?.nudge()
const onVisible = () => document.visibilityState === 'visible' && client?.nudge()

export function stopLive() {
  stopRoomSound()
  stopSessionMarkers()
  client?.stop()
  client = null
  relay = null
  window.removeEventListener('online', nudge)
  document.removeEventListener('visibilitychange', onVisible)
}
