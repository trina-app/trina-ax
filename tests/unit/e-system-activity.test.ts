// The desktop app's word on the computer's own use (desktop/src/common/system-activity.ts): idle time and a locked
// screen from Electron's powerMonitor, for the team page's "in use" and so for holding phone pushes
// (docs/DECISIONS.md "Phone notifications when I'm away").
import { expect, test } from 'bun:test'
import { readSystemActivity, SYSTEM_IDLE_THRESHOLD_S } from '../../desktop/src/common/system-activity'

test('idle seconds become ms; locked is told; the 10-minute threshold is asked', () => {
  let asked = 0
  expect(readSystemActivity({ getSystemIdleState: (t) => { asked = t; return 'active' }, getSystemIdleTime: () => 42 })).toEqual({ locked: false, idleMs: 42_000 })
  expect(asked).toBe(SYSTEM_IDLE_THRESHOLD_S)
  expect(readSystemActivity({ getSystemIdleState: () => 'locked', getSystemIdleTime: () => 5 })).toEqual({ locked: true, idleMs: 5000 })
  expect(readSystemActivity({ getSystemIdleState: () => 'idle', getSystemIdleTime: () => 700 })).toEqual({ locked: false, idleMs: 700_000 })
})

test('a system that cannot tell (unknown, a throw, a bad number): nothing, the page counts only its own input', () => {
  expect(readSystemActivity({ getSystemIdleState: () => 'unknown', getSystemIdleTime: () => 0 })).toBeNull()
  expect(readSystemActivity({ getSystemIdleState: () => { throw new Error('no') }, getSystemIdleTime: () => 0 })).toBeNull()
  expect(readSystemActivity({ getSystemIdleState: () => 'active', getSystemIdleTime: () => Number.NaN })).toBeNull()
})
