// The extension's service worker: listeners first (a worker woken by an event must find them at the top level), then
// the connection. The popup talks to it with chrome.runtime messages (popup.ts).
import { runningCalls, stopAllRuns, stopRun, WINDOW_CLOSED, workingRuns } from './calls'
import { connect, linked, unlink } from './link'
import { cancelPairing, installPairingListeners, pairState, startPairing, teamOrigin, wantPairing } from './pairing'
import { live, loadLink, refreshBadge } from './state'
import { browserLabel } from './ids'
import { installRunListeners, setRunClosedHandler, sweepRuns } from './runs'
import { installTabListeners, setUserStopHandler } from './tabs'

export interface PopupStatus {
  linked: boolean
  origin?: string
  team?: string
  user?: string
  /** what the person called this browser profile at Connect */
  label?: string
  /** a suggested name for the Connect field ("Chrome on Mac") */
  suggestedLabel: string
  online: boolean
  /** the tasks working now, each with its own Stop */
  runs: { id: string; title: string; tabs: number }[]
  stopped: boolean
  pair: Awaited<ReturnType<typeof pairState>>
}

installTabListeners()
installPairingListeners(linked)
installRunListeners()
setUserStopHandler(stopAllRuns)
setRunClosedHandler((runId) => stopRun(runId, WINDOW_CLOSED))

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
  return {
    linked: Boolean(l),
    origin: l?.origin,
    team: l?.team.name,
    user: l?.user.name,
    label: l?.label,
    suggestedLabel: browserLabel(navigator.userAgent, navigator.userAgentData, Boolean(navigator.brave)),
    online: live.online,
    runs: workingRuns(),
    stopped: live.stoppedAt > 0 && Date.now() - live.stoppedAt < 60_000,
    pair: await pairState(),
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
        if (origin) await wantPairing(origin, String(msg.label ?? ''))
        break
      }
      case 'cancelPair':
        await cancelPairing()
        break
      case 'stop':
        if (typeof msg.runId === 'string') stopRun(msg.runId)
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
