// Meeting notes behind the bridge (desktop/src/main/meeting-control.ts): nothing listens without the app's own yes,
// one meeting at a time, the page hears state and lines, "can't hear the call" while a call app runs and its sound
// stays silent, and the bridge objects (preload) only where the app offers it.
import { describe, expect, mock, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// the main process's Electron parts are not used here (the dialog and the menu bar item are injected / off). The names
// a later test file imports from its own mock (office-update-desktop-updater: app, session, …) are here too: in one
// test process the first mock fixes the module's export names, and CI on Linux can run this file first.
mock.module('electron', () => ({ dialog: {}, Menu: {}, nativeImage: {}, shell: {}, Tray: class {}, app: {}, session: {}, powerMonitor: {}, BaseWindow: {}, autoUpdater: {} }))
const { MeetingControl, NO_CALL_SOUND_MS } = await import('../../desktop/src/main/meeting-control')
import type { DesktopMeetingState } from '../../shared/src/desktop-bridge'

const frame = (kind: number, samples: Float32Array) => {
  const b = Buffer.alloc(5 + samples.length * 4)
  b[0] = kind; b.writeUInt32LE(samples.length, 1)
  samples.forEach((v, i) => b.writeFloatLE(v, 5 + i * 4))
  return b
}
const tone = (ms: number, amp: number) => Float32Array.from({ length: (ms * 16000) / 1000 }, (_, i) => amp * Math.sin(i / 5))

function fakeHelper(dir: string, callApps: string[]) {
  const raw = path.join(dir, 'frames.bin')
  fs.writeFileSync(raw, Buffer.concat([tone(3000, 0.0005), tone(2000, 0.2), tone(1500, 0.0005)].map((p) => frame(0x4d, p))))
  const helper = path.join(dir, 'helper.sh')
  fs.writeFileSync(helper, `#!/bin/sh\necho '{"event":"started","microphone":true,"callSound":${callApps.length > 0},"callApps":${JSON.stringify(callApps)}}' >&2\ncat ${JSON.stringify(raw)}\nexec sleep 30\n`, { mode: 0o755 })
  return helper
}

function control(o: { yes: boolean; helper: string | null; team?: boolean; input?: number; user?: string }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetd-'))
  const states: DesktopMeetingState[] = []
  const lines: unknown[] = []
  let asked = 0
  const fetch = async () => Response.json({ lines: [{ start: 0, end: 1, text: 'hello' }] })
  const session = { fetch } as any
  const c = new MeetingControl({
    win: () => null, locale: () => 'en',
    team: () => (o.team === false ? null : { id: 'team-1', userId: o.user ?? 'alice', origin: 'https://team.example', session }),
    state: (s) => states.push(s), lines: (l) => lines.push(...l),
    ask: async () => { asked++; return o.yes }, tray: false, helper: () => o.helper,
    lastInput: () => o.input ?? Date.now(), dataDir,
  })
  return { c, states, lines, asked: () => asked, dataDir }
}

describe('meeting notes behind the bridge', () => {
  test('no helper: version 0 and start is unavailable, nothing asked', async () => {
    const { c, asked } = control({ yes: true, helper: null })
    expect(c.version()).toBe(0)
    expect(await c.start()).toBe('unavailable')
    expect(asked()).toBe(0)
  })
  test("the app's dialog answered no: nothing starts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetc-'))
    const { c, states, asked } = control({ yes: false, helper: fakeHelper(dir, []) })
    expect(await c.start()).toBe('cancelled')
    expect(asked()).toBe(1)
    // asked again at once (a page script looping after a Cancel): no dialog
    expect(await c.start()).toBe('cancelled')
    expect(asked()).toBe(1)
    expect(c.running()).toBe(false)
    expect(states).toEqual([])
  })
  test('no key or click of the person just before: no dialog at all', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetc-'))
    const { c, asked } = control({ yes: true, helper: fakeHelper(dir, []), input: Date.now() - 60_000 })
    expect(await c.start()).toBe('cancelled')
    expect(asked()).toBe(0)
  })
  test('yes: listening, lines reach the page, a second start is busy, stop returns the lines and goes idle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetc-'))
    const { c, states, lines } = control({ yes: true, helper: fakeHelper(dir, []) })
    expect(await c.start()).toBe('started')
    expect(await c.start()).toBe('busy')
    for (let i = 0; i < 100 && !lines.length; i++) await Bun.sleep(20)
    const all = await c.stop()
    expect(all.map((l) => l.text)).toEqual(['hello'])
    expect(states[0]!.state).toBe('listening')
    expect(states.some((s) => s.microphone === true)).toBe(true)
    expect(states.at(-1)!.state).toBe('idle')
    expect(c.lines().map((l) => l.text)).toEqual(['hello'])
    // the lines stay on this computer until the page says the note is saved
    const u = c.unsaved()!
    expect(u.lines.map((l) => l.text)).toEqual(['hello'])
    // another person on this computer is not offered them
    ;(c as any).d.team = () => ({ id: 'team-1', userId: 'bob', origin: 'https://team.example', session: {} })
    expect(c.unsaved()).toBeNull()
    ;(c as any).d.team = () => ({ id: 'team-2', userId: 'alice', origin: 'https://other.example', session: {} })
    expect(c.unsaved()).toBeNull()
    ;(c as any).d.team = () => ({ id: 'team-1', userId: 'alice', origin: 'https://team.example', session: {} })
    c.saved(u.startedAt + 1)
    expect(c.unsaved()).not.toBeNull()
    c.saved(u.startedAt)
    expect(c.unsaved()).toBeNull()
  })
  test('no team open (signed out): unavailable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetc-'))
    const { c } = control({ yes: true, helper: fakeHelper(dir, []), team: false })
    expect(await c.start()).toBe('unavailable')
  })
  test("speech on the microphone, a call app running, its sound silent: \"can't hear the call\"", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetc-'))
    const { c, states } = control({ yes: true, helper: fakeHelper(dir, ['us.zoom.xos']) })
    await c.start()
    for (let i = 0; i < 100 && !states.some((s) => s.callApps?.length); i++) await Bun.sleep(20)
    // as if 20 s had passed since Start
    ;(c as any).heard.since -= NO_CALL_SOUND_MS + 1
    ;(c as any).level('me', 0.2)
    expect(c.state().problem).toBe('no_call_sound')
    ;(c as any).level('others', 0.2)
    expect(c.state().problem).toBeUndefined()
    await c.stop()
  })
  test('a browser or Slack being open is not a call: no warning in a meeting room', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetc-'))
    const { c, states } = control({ yes: true, helper: fakeHelper(dir, ['com.google.Chrome', 'com.tinyspeck.slackmacgap']) })
    await c.start()
    for (let i = 0; i < 100 && !states.some((s) => s.callApps?.length); i++) await Bun.sleep(20)
    ;(c as any).heard.since -= NO_CALL_SOUND_MS + 1
    ;(c as any).level('me', 0.2)
    expect(c.state().problem).toBeUndefined()
    await c.stop()
  })
})

describe('the team changes while the dialog is open', () => {
  test('another team (or a sign-out) by the time of the yes: nothing starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetc-'))
    let origin = 'https://a.example'
    const session = { fetch: async () => Response.json({ lines: [] }) } as any
    const c = new MeetingControl({
      win: () => null, locale: () => 'en', team: () => ({ id: origin, userId: 'alice', origin, session }), state: () => {}, lines: () => {},
      ask: async () => { origin = 'https://b.example'; return true }, tray: false, helper: () => fakeHelper(dir, []),
      lastInput: () => Date.now(), dataDir: dir,
    })
    expect(await c.start()).toBe('cancelled')
    expect(c.running()).toBe(false)
  })
})

describe('the bridge object', () => {
  test('the preload offers meeting only when the app says so, and start goes to the main process', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../../desktop/src/preload/app.ts'), 'utf8')
    expect(src).toContain("...(info?.meeting")
    expect(src).toContain("start: () => ipcRenderer.invoke('bridge:meeting-start')")
    expect(src).toContain("onLines: on('bridge:meeting-lines-changed')")
    const main = fs.readFileSync(path.join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    expect(main).toMatch(/bridge:meeting-start', \(e\) => \(fromApp\(e\) && !process\.mas/)
    expect(main).toContain('meeting: process.mas ? 0 :')
  })
})
