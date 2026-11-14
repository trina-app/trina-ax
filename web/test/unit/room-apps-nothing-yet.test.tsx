// "Nothing yet?" in an app's guide (QA TC-2389 re-test): while the guide waits it reads the app again every 4 s
// (AppsDialog useLive), each time a new app object. The line must still come two minutes after the app was added.
// Fake timers (useNothingYet's clock) stand in for the 2 minutes; the app is replaced every 4 s, as the polling does.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act, useEffect, useState } from 'react'
import { NOTHING_YET_MS } from '../../src/lib/roomApps'
import { useNothingYet, type NothingYetClock } from '../../src/components/rooms/apps/GuideParts'
import { installDom, mount, removeDom } from './dom-host'

beforeEach(() => installDom())
afterEach(() => removeDom())

/** A clock and timers that move only when the test says so. */
function fakeClock(start: number) {
  let now = start
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>()
  const clock: NothingYetClock & { every: (fn: () => void, ms: number) => number; live: () => number } = {
    now: () => now,
    set: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id },
    clear: (id) => { timers.delete(id as number) },
    every: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn, every: ms }); return id },
    live: () => timers.size,
  }
  /** move the clock on by `ms`, running every timer that comes due on the way, in order */
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, t] = due
      now = t.at
      if (t.every) t.at += t.every
      else timers.delete(id)
      await act(async () => { t.fn() })
    }
    now = end
  }
  return { clock, advance }
}

const POLL_MS = 4000

/** The guide's part under test: the app as the screen holds it, replaced by a new object every 4 s (useLive). */
function Probe({ clock, createdAt }: { clock: ReturnType<typeof fakeClock>['clock']; createdAt: string }) {
  const [app, setApp] = useState({ id: 'app-1', createdAt, reads: 0 })
  useEffect(() => {
    const id = clock.every(() => setApp((a) => ({ ...a, reads: a.reads + 1 })), POLL_MS)
    return () => clock.clear(id)
  }, [clock])
  const shown = useNothingYet(app.createdAt, true, clock)
  return <p data-testid="probe" data-reads={app.reads}>{shown ? 'Nothing yet?' : 'waiting'}</p>
}

test('"Nothing yet?" appears two minutes after the app was added although the app is read again every 4 s', async () => {
  const start = Date.parse('2026-11-15T09:00:00.000Z')
  const { clock, advance } = fakeClock(start)
  const m = await mount(<Probe clock={clock} createdAt={new Date(start).toISOString()} />)
  expect(m.get('probe').textContent).toBe('waiting')
  await advance(NOTHING_YET_MS - 1000)
  expect(Number(m.get('probe').getAttribute('data-reads'))).toBeGreaterThanOrEqual(29)
  expect(m.get('probe').textContent).toBe('waiting')
  await advance(2000)
  expect(m.get('probe').textContent).toBe('Nothing yet?')
  // and it stays while the app keeps being read
  await advance(POLL_MS * 3)
  expect(m.get('probe').textContent).toBe('Nothing yet?')
  await m.unmount()
})

test('an app added more than two minutes ago shows it at once; one that no longer waits does not', async () => {
  const start = Date.parse('2026-11-15T09:00:00.000Z')
  const { clock } = fakeClock(start)
  function Once({ waiting }: { waiting: boolean }) {
    const shown = useNothingYet(new Date(start - NOTHING_YET_MS - 1).toISOString(), waiting, clock)
    return <p data-testid="once">{shown ? 'yes' : 'no'}</p>
  }
  const a = await mount(<Once waiting />)
  expect(a.get('once').textContent).toBe('yes')
  await a.unmount()
  const b = await mount(<Once waiting={false} />)
  expect(b.get('once').textContent).toBe('no')
  await b.unmount()
})
