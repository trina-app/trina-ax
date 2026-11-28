// The extension's service worker: listeners first (a worker woken by an event must find them at the top level), then
// the connection. The popup talks to it with chrome.runtime messages (popup.ts).
import { runningCalls, stopAllRuns, stopRun, WINDOW_CLOSED, workingRuns } from './calls'
import { connect, linked, rename, unlink } from './link'
import { cancelPairing, cleanLabel, installPairingListeners, pairState, profileEmail, shouldAskEmail, startPairing, teamOrigin, wantPairing } from './pairing'
import { live, loadLink, refreshBadge, saveLink } from './state'

/** the popup's last rename could not be kept (offline): it says so once */
let renameFailed = false
import { browserLabel } from './ids'
import { installRunListeners, setBusyRuns, setRunClosedHandler, sweepRuns } from './runs'
import { installTabListeners, setUserStopHandler } from './tabs'

export interface PopupStatus {
  linked: boolean
  origin?: string
  team?: string
  user?: string
  /** what the person called this browser profile at Connect */
  label?: string
  /** the name an empty Connect field falls back to ("Chrome on Mac") */
  suggestedLabel: string
  /** the profile's Google account, when the extension may read it: the Connect field starts with it */
  email?: string
  /** Connect asks Chrome, once, for the permission to read that account (an empty field then becomes the email) */
  askEmail: boolean
  online: boolean
  /** the tasks working now, each with its own Stop */
  runs: { id: string; title: string; tabs: number }[]
  stopped: boolean
  renameFailed: boolean
  pair: Awaited<ReturnType<typeof pairState>>
  /** the person's language as the team told it: the popup speaks it (else the browser's) */
  locale?: string
}

installTabListeners()
installPairingListeners(linked)
installRunListeners()
setUserStopHandler(stopAllRuns)
setRunClosedHandler((runId) => stopRun(runId, WINDOW_CLOSED))
setBusyRuns(() => new Set(runningCalls().map((c) => c.run.id)))

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'reconnect') return
  void connect()
  // a task's window closes after ten minutes without a call
  void sweepRuns(new Set(runningCalls().map((c) => c.run.id)))
})
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => void connect())
void chrome.alarms.create('reconnect', { periodInMinutes: 1 })

async function status(): Promise<PopupStatus> {
  if (!live.link) live.link = await loadLink()
  const l = live.link
  // only the Connect screen needs the account
  const email = l ? null : await profileEmail()
  return {
    linked: Boolean(l),
    origin: l?.origin,
    team: l?.team.name,
    user: l?.user.name,
    label: l?.label,
    suggestedLabel: browserLabel(navigator.userAgent, navigator.userAgentData, Boolean(navigator.brave)),
    ...(email ? { email } : {}),
    askEmail: l ? false : await shouldAskEmail(),
    online: live.online,
    runs: workingRuns(),
    stopped: live.stoppedAt > 0 && Date.now() - live.stoppedAt < 60_000,
    pair: await pairState(),
    renameFailed: (() => { const f = renameFailed; renameFailed = false; return f })(),
    ...(l?.locale ? { locale: l.locale } : {}),
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // only the extension's own pages (the popup) talk to the worker: it has no content scripts and no external pages
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false
  void (async () => {
    switch (msg?.type) {
      case 'pair': {
        const origin = teamOrigin(String(msg.origin ?? ''))
        if (origin) await startPairing(origin, String(msg.label ?? ''))
        break
      }
      case 'want': {
        const origin = teamOrigin(String(msg.origin ?? ''))
        if (origin) await wantPairing(origin, String(msg.label ?? ''), msg.askEmail === true)
        break
      }
      case 'cancelPair':
        await cancelPairing()
        break
      case 'stop':
        if (typeof msg.runId === 'string') stopRun(msg.runId)
        break
      case 'rename': {
        const name = cleanLabel(String(msg.label ?? ''))
        if (live.link && rename(name)) {
          live.link = { ...live.link, label: name }
          await saveLink(live.link)
        } else renameFailed = true
        break
      }
      case 'linked':
        // the desktop app's pair page kept a new link (pair.ts): connect with it now
        await linked()
        break
      case 'disconnect':
        await unlink()
        break
    }
    void connect()
    reply(await status())
  })()
  return true
})

refreshBadge()
void connect()
