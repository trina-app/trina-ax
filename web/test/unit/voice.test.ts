// The composer's mic: shown when voice input is on (or the server is older), hidden for everyone when it is off. Rooms: blocked while every chat is confidential and voice input goes
// out. Holding Space and a finger on the mic (lib/voiceInput.ts): the 400 ms threshold, repeats, IME keys, an empty
// box against one with text, letting go early, Esc, the window losing the focus, the 5-minute cap, the permission
// question; the transcription job's own label.
import { describe, expect, test } from 'bun:test'
import { micState, voiceBlockedHere, voiceBlockedInRoom } from '../../src/lib/voice'
import { CAP_MS, DRAG_CANCEL_PX, HOLD_MS, jobLabel, jobWaiting, VoiceInput, WARN_MS, type KeyLike, type VoiceDeps, type VoiceNote } from '../../src/lib/voiceInput'

const me = (role: 'owner' | 'admin' | 'member', voiceInput?: boolean) => ({ user: { role }, team: { name: 'T', defaultLocale: 'en' as const, ...(voiceInput === undefined ? {} : { voiceInput }) } })

describe('mic visibility', () => {
  test('on: everyone sees the mic', () => {
    for (const r of ['owner', 'admin', 'member'] as const) expect(micState(me(r, true))).toBe('on')
  })
  test('an older server (no voiceInput) or no session: the mic stays', () => {
    expect(micState(me('member'))).toBe('on')
    expect(micState(null)).toBe('on')
  })
  test('off (it can\'t be used on this server): nobody sees it, owners and admins included', () => {
    for (const r of ['owner', 'admin', 'member'] as const) expect(micState(me(r, false))).toBe('hidden')
  })
})

describe('confidential chats', () => {
  const team = (outside?: true) => ({ team: { name: 'T', defaultLocale: 'en' as const, voiceInput: true, ...(outside ? { voiceInputOutside: outside } : {}) } })
  test('voice input that goes to OpenRouter is not used in a confidential chat', () => {
    expect(voiceBlockedHere(team(true), true)).toBe(true)
  })
  test('an ordinary chat, a chat not known yet, voice input on this server, or an older server: the mic records', () => {
    expect(voiceBlockedHere(team(true), false)).toBe(false)
    // not known yet (a chat outside the loaded list being asked for): the server still refuses it if it must
    expect(voiceBlockedHere(team(true), null)).toBe(false)
    expect(voiceBlockedHere(team(), true)).toBe(false)
    expect(voiceBlockedHere(null, true)).toBe(false)
  })
})

describe('rooms', () => {
  const me = (all: boolean, outside: boolean) => ({ server: { version: '1', dev: false, ...(all ? { allChatsConfidential: true as const } : {}) }, team: { name: 'T', defaultLocale: 'en' as const, voiceInput: true, ...(outside ? { voiceInputOutside: true as const } : {}) } })
  test('a room names no chat: while every chat is confidential and voice input goes out, it says why instead of recording', () => {
    expect(voiceBlockedInRoom(me(true, true))).toBe(true)
  })
  test('an ordinary server, voice input on this server, or no session: the mic records in a room', () => {
    expect(voiceBlockedInRoom(me(false, true))).toBe(false)
    expect(voiceBlockedInRoom(me(true, false))).toBe(false)
    expect(voiceBlockedInRoom(null)).toBe(false)
  })
})

// The hold-Space and finger moves (lib/voiceInput.ts), on a clock of their own.
function rig(o: { blocked?: boolean; granted?: boolean; slowStart?: boolean; failStart?: unknown; busyElsewhere?: boolean } = {}) {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const log: string[] = []
  const notes: (VoiceNote | null)[] = []
  let gate: { resolve: () => void; reject: (e: unknown) => void } | null = null
  const jobs: { signal: AbortSignal; resolve: (s: string) => void; reject: (e: unknown) => void }[] = []
  const deps: VoiceDeps = {
    start: () => {
      log.push('start')
      if (o.failStart) return Promise.reject(o.failStart)
      return o.slowStart ? new Promise<void>((resolve, reject) => void (gate = { resolve, reject })) : Promise.resolve()
    },
    stop: async () => {
      log.push('stop')
      return new File(['sound'], 'voice.webm', { type: 'audio/webm' })
    },
    cancel: () => void log.push('cancel'),
    transcribe: (_file, signal) =>
      new Promise<string>((resolve, reject) => {
        log.push('transcribe')
        jobs.push({ signal, resolve, reject })
      }),
    append: (s) => void log.push(`append:${s}`),
    typeSpace: () => void log.push('typeSpace'),
    removeSpace: (at) => void log.push(`removeSpace:${at}`),
    focusBox: () => {},
    note: (n) => void notes.push(n),
    blocked: () => !!o.blocked,
    canStart: () => !o.busyElsewhere,
    granted: () => o.granted ?? true,
    holdUsed: () => void log.push('holdUsed'),
    setTimeout: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => void timers.delete(h as number),
    changed: () => {},
  }
  const v = new VoiceInput(deps)
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
      await flush()
    }
    now = end
    await flush()
  }
  return { v, log, notes, jobs, advance, flush, open: () => gate!.resolve(), refuse: (e: unknown) => gate!.reject(e) }
}
type Key = KeyLike & { prevented: boolean }
const key = (k: string, more: Partial<KeyLike> = {}): Key => {
  const e: Key = { key: k, prevented: false, preventDefault: () => void (e.prevented = true), stopPropagation: () => {}, ...more }
  return e
}
const empty = { value: '', selectionStart: 0, selectionEnd: 0 }
const typed = (value: string, at = value.length) => ({ value, selectionStart: at, selectionEnd: at })
const hold = { hold: true, menuOpen: false }

describe('hold Space', () => {
  test('an empty box: the Space is held back and the recording starts once it was held 400 ms', async () => {
    const r = rig()
    const down = key(' ')
    expect(r.v.boxKeyDown(down, empty, hold)).toBe(true)
    expect(down.prevented).toBe(true)
    expect(r.v.phase).toBe('waiting')
    await r.advance(HOLD_MS - 1)
    expect(r.log).toEqual([])
    await r.advance(1)
    expect(r.log).toEqual(['start', 'holdUsed'])
    expect(r.v.phase).toBe('recording')
    expect(r.v.mode).toBe('hold')
    expect(r.v.live).toBe('recording')
  })

  test('repeats while it waits are held back and do not start it again; a repeat, an IME key or a modifier never starts a wait', async () => {
    const r = rig()
    r.v.boxKeyDown(key(' '), empty, hold)
    for (const ms of [30, 30, 30]) {
      const rep = key(' ', { repeat: true })
      r.v.windowKeyDown(rep)
      expect(rep.prevented).toBe(true)
      expect(r.v.boxKeyDown(rep, empty, hold)).toBe(false)
      await r.advance(ms)
    }
    await r.advance(HOLD_MS - 90)
    expect(r.log.filter((x) => x === 'start')).toHaveLength(1)

    for (const k of [key(' ', { repeat: true }), key(' ', { keyCode: 229 }), key(' ', { isComposing: true }), key(' ', { shiftKey: true }), key(' ', { ctrlKey: true }), key(' ', { altKey: true }), key(' ', { metaKey: true }), key('a')]) {
      const q = rig()
      expect(q.v.boxKeyDown(k, empty, hold)).toBe(false)
      expect(k.prevented).toBe(false)
      expect(q.v.phase).toBe('idle')
    }
  })

  test('a "/", "#" or "@" list open, a touch screen (no hold) or a selection: Space is only a Space', () => {
    for (const [box, o] of [[empty, { hold: true, menuOpen: true }], [empty, { hold: false, menuOpen: false }], [{ value: 'abc', selectionStart: 0, selectionEnd: 3 }, hold]] as const) {
      const r = rig()
      const e = key(' ')
      expect(r.v.boxKeyDown(e, box, o)).toBe(false)
      expect(e.prevented).toBe(false)
      expect(r.v.phase).toBe('idle')
    }
  })

  test('a box with text: the first Space types as usual, and at 400 ms that one space is taken back', async () => {
    const r = rig()
    const down = key(' ')
    expect(r.v.boxKeyDown(down, typed('hello', 2), hold)).toBe(false)
    expect(down.prevented).toBe(false)
    await r.advance(HOLD_MS)
    expect(r.log).toEqual(['removeSpace:2', 'start', 'holdUsed'])
  })

  test('a short tap is a space: in an empty box the held-back Space goes in; in a box with text nothing more happens', async () => {
    const a = rig()
    a.v.boxKeyDown(key(' '), empty, hold)
    await a.advance(150)
    a.v.windowKeyUp(key(' '))
    expect(a.log).toEqual(['typeSpace'])
    expect(a.v.phase).toBe('idle')
    await a.advance(HOLD_MS)
    expect(a.log).toEqual(['typeSpace'])

    const b = rig()
    b.v.boxKeyDown(key(' '), typed('hi'), hold)
    await b.advance(399)
    b.v.windowKeyUp(key(' '))
    await b.advance(HOLD_MS)
    expect(b.log).toEqual([])
  })

  test('another key before 400 ms ends the wait (typing is unchanged): the held-back Space goes in before it', async () => {
    const r = rig()
    r.v.boxKeyDown(key(' '), empty, hold)
    await r.advance(80)
    const other = key('a')
    r.v.windowKeyDown(other)
    expect(other.prevented).toBe(false)
    expect(r.log).toEqual(['typeSpace'])
    await r.advance(HOLD_MS)
    expect(r.log).toEqual(['typeSpace'])
    // the window losing the focus while it waits is the same
    const q = rig()
    q.v.boxKeyDown(key(' '), empty, hold)
    q.v.away()
    expect(q.log).toEqual(['typeSpace'])
  })

  test('letting go of Space transcribes; the words go to the box and are not sent', async () => {
    const r = rig()
    r.v.boxKeyDown(key(' '), empty, hold)
    await r.advance(HOLD_MS)
    // the bar stands where the box was: the held Space never scrolls the page or types
    const rep = key(' ', { repeat: true })
    r.v.windowKeyDown(rep)
    expect(rep.prevented).toBe(true)
    await r.advance(1500)
    r.v.windowKeyUp(key(' '))
    await r.flush()
    expect(r.v.phase).toBe('transcribing')
    expect(r.v.live).toBe('transcribing')
    r.jobs[0]!.resolve('  받아쓴 문장입니다 ')
    await r.flush()
    expect(r.log).toEqual(['start', 'holdUsed', 'stop', 'transcribe', 'append:받아쓴 문장입니다'])
    expect(r.v.phase).toBe('idle')
    expect(r.v.live).toBe('inserted')
  })

  test('nothing heard, or a failed job: a note, nothing in the box', async () => {
    const r = rig()
    r.v.click()
    await r.flush()
    void r.v.finish()
    await r.flush()
    r.jobs[0]!.resolve('   ')
    await r.flush()
    expect(r.notes.at(-1)).toEqual({ kind: 'empty' })
    r.v.click()
    await r.flush()
    void r.v.finish()
    await r.flush()
    const boom = new Error('provider down')
    r.jobs[1]!.reject(boom)
    await r.flush()
    expect(r.notes.at(-1)).toEqual({ kind: 'error', error: boom })
    expect(r.log.some((x) => x.startsWith('append:'))).toBe(false)
  })

  test('Esc cancels while recording, and while transcribing (the job is let go, its words never arrive)', async () => {
    const r = rig()
    r.v.boxKeyDown(key(' '), empty, hold)
    await r.advance(HOLD_MS)
    const esc = key('Escape')
    r.v.windowKeyDown(esc)
    expect(esc.prevented).toBe(true)
    expect(r.log).toEqual(['start', 'holdUsed', 'cancel'])
    expect(r.v.phase).toBe('idle')
    // the Space still held after Esc: no space, no new wait, until it is let go
    const rep = key(' ', { repeat: true })
    r.v.windowKeyDown(rep)
    expect(rep.prevented).toBe(true)
    r.v.windowKeyUp(key(' '))

    r.v.click()
    await r.flush()
    void r.v.finish()
    await r.flush()
    expect(r.v.phase).toBe('transcribing')
    r.v.windowKeyDown(key('Escape'))
    expect(r.jobs[0]!.signal.aborted).toBe(true)
    expect(r.v.phase).toBe('idle')
    r.jobs[0]!.resolve('too late')
    await r.flush()
    expect(r.log.some((x) => x.startsWith('append:'))).toBe(false)
  })

  test('the window losing the focus or the tab hidden while Space is held transcribes; a clicked recording goes on', async () => {
    const r = rig()
    r.v.boxKeyDown(key(' '), empty, hold)
    await r.advance(HOLD_MS + 2000)
    r.v.away()
    await r.flush()
    expect(r.log).toContain('transcribe')

    const c = rig()
    c.v.click()
    await c.flush()
    c.v.away()
    await c.flush()
    expect(c.v.phase).toBe('recording')
    expect(c.log).toEqual(['start'])
  })

  test('5 minutes at most: the time left shows in the last 30 s and the cap transcribes what was recorded', async () => {
    expect(CAP_MS).toBe(5 * 60_000)
    expect(WARN_MS).toBe(30_000)
    const r = rig()
    r.v.click()
    await r.flush()
    await r.advance(CAP_MS - 1)
    expect(r.v.phase).toBe('recording')
    await r.advance(1)
    expect(r.log).toEqual(['start', 'stop', 'transcribe'])
    r.jobs[0]!.resolve('긴 회의 메모')
    await r.flush()
    expect(r.log).toContain('append:긴 회의 메모')
  })

  test('Space let go while the browser asks for the microphone: it records on until ✓; already allowed: nothing was recorded, no job', async () => {
    const asked = rig({ granted: false, slowStart: true })
    asked.v.boxKeyDown(key(' '), empty, hold)
    await asked.advance(HOLD_MS)
    expect(asked.v.phase).toBe('starting')
    asked.v.windowKeyUp(key(' '))
    asked.open()
    await asked.flush()
    expect(asked.v.phase).toBe('recording')
    expect(asked.v.mode).toBe('toggle')
    // in a toggle recording a Space on a button still works there
    const onButton = key(' ')
    asked.v.windowKeyDown(onButton, { onControl: true })
    expect(onButton.prevented).toBe(false)

    const allowed = rig({ granted: true, slowStart: true })
    allowed.v.boxKeyDown(key(' '), empty, hold)
    await allowed.advance(HOLD_MS)
    allowed.v.windowKeyUp(key(' '))
    allowed.open()
    await allowed.flush()
    expect(allowed.log).toEqual(['start', 'holdUsed', 'cancel'])
    expect(allowed.v.phase).toBe('idle')
    expect(allowed.notes.filter(Boolean)).toEqual([])
  })

  test('a short hold once the microphone is on is still transcribed (a quick "네")', async () => {
    const r = rig()
    r.v.boxKeyDown(key(' '), empty, hold)
    await r.advance(HOLD_MS + 50)
    r.v.windowKeyUp(key(' '))
    await r.flush()
    expect(r.log).toEqual(['start', 'holdUsed', 'stop', 'transcribe'])
  })

  test('one microphone at a time: while another box records, Space and the mic start nothing here', async () => {
    const r = rig({ busyElsewhere: true })
    r.v.boxKeyDown(key(' '), typed('hi'), hold)
    await r.advance(HOLD_MS)
    r.v.click()
    expect(r.v.pressStart(1, 1)).toBe(false)
    expect(r.log).toEqual(['removeSpace:2'])
    expect(r.v.phase).toBe('idle')
  })

  test('Esc aimed at a menu, a list, a dialog or another box leaves the recording alone; in a Space hold it cancels from anywhere', async () => {
    const r = rig()
    r.v.click()
    await r.flush()
    const elsewhere = key('Escape')
    r.v.windowKeyDown(elsewhere, { ours: false })
    expect(elsewhere.prevented).toBe(false)
    expect(r.v.phase).toBe('recording')
    r.v.windowKeyDown(key('Escape'), { ours: true })
    expect(r.v.phase).toBe('idle')

    const h = rig()
    h.v.boxKeyDown(key(' '), empty, hold)
    await h.advance(HOLD_MS)
    h.v.windowKeyDown(key('Escape'), { ours: false })
    expect(h.v.phase).toBe('idle')
    expect(h.log).toEqual(['start', 'holdUsed', 'cancel'])
  })

  test('the box goes away (another chat or room) while starting, recording or transcribing: nothing goes on', async () => {
    const starting = rig({ slowStart: true })
    starting.v.click()
    starting.v.dispose()
    starting.open()
    await starting.flush()
    expect(starting.log).toEqual(['start', 'cancel'])
    expect(starting.v.phase).toBe('idle')

    const recording = rig()
    recording.v.click()
    await recording.flush()
    recording.v.dispose()
    expect(recording.log).toEqual(['start', 'cancel'])
    await recording.advance(CAP_MS)
    expect(recording.log).toEqual(['start', 'cancel'])

    const transcribing = rig()
    transcribing.v.click()
    await transcribing.flush()
    void transcribing.v.finish()
    await transcribing.flush()
    transcribing.v.dispose()
    expect(transcribing.jobs[0]!.signal.aborted).toBe(true)
    transcribing.jobs[0]!.resolve('late words')
    await transcribing.flush()
    expect(transcribing.log.some((x) => x.startsWith('append:'))).toBe(false)
  })

  test('a start that fails turns the microphone off; after Esc it says nothing', async () => {
    const r = rig({ slowStart: true })
    r.v.click()
    r.v.windowKeyDown(key('Escape'))
    r.refuse(new Error('denied'))
    await r.flush()
    expect(r.log).toEqual(['start', 'cancel'])
    expect(r.notes.filter(Boolean)).toEqual([])
  })

  test('a confidential place: the note instead of a recording, and the held Space types nothing until let go', async () => {
    const r = rig({ blocked: true })
    r.v.boxKeyDown(key(' '), typed('plan'), hold)
    await r.advance(HOLD_MS)
    expect(r.log).toEqual(['removeSpace:4'])
    expect(r.notes.at(-1)).toEqual({ kind: 'blocked' })
    const rep = key(' ', { repeat: true })
    r.v.windowKeyDown(rep)
    expect(rep.prevented).toBe(true)
    r.v.windowKeyUp(key(' '))
    const after = key(' ', { repeat: true })
    r.v.windowKeyDown(after)
    expect(after.prevented).toBe(false)
    // the mic too
    r.v.click()
    expect(r.log).toEqual(['removeSpace:4'])
  })

  test('a microphone that cannot start says why', async () => {
    const denied = new Error('denied')
    const r = rig({ failStart: denied })
    r.v.click()
    await r.flush()
    expect(r.v.phase).toBe('idle')
    expect(r.notes.at(-1)).toEqual({ kind: 'error', error: denied })
    expect(r.log).toEqual(['start', 'cancel'])
  })
})

describe('the mic with a finger', () => {
  test('a tap records until ✓; held, letting go transcribes', async () => {
    const tap = rig()
    expect(tap.v.pressStart(10, 10)).toBe(true)
    await tap.flush()
    await tap.advance(120)
    tap.v.pressEnd()
    expect(tap.v.mode).toBe('toggle')
    await tap.advance(2000)
    expect(tap.v.phase).toBe('recording')

    const held = rig()
    held.v.pressStart(10, 10)
    await held.flush()
    await held.advance(HOLD_MS)
    expect(held.v.mode).toBe('hold')
    held.v.pressMove(30, 20)
    held.v.pressEnd()
    await held.flush()
    expect(held.log).toEqual(['start', 'stop', 'transcribe'])
  })

  test('sliding away cancels', async () => {
    const r = rig()
    r.v.pressStart(100, 100)
    await r.flush()
    await r.advance(HOLD_MS)
    r.v.pressMove(100 - DRAG_CANCEL_PX - 1, 100)
    expect(r.log).toEqual(['start', 'cancel'])
    expect(r.v.phase).toBe('idle')
  })

  test('a finger let go while the browser asks for the microphone: it records on until ✓', async () => {
    const r = rig({ slowStart: true, granted: false })
    r.v.pressStart(10, 10)
    await r.advance(3000)
    r.v.pressEnd()
    r.open()
    await r.flush()
    expect(r.v.phase).toBe('recording')
    expect(r.v.mode).toBe('toggle')
  })
})

describe('a transcription job\'s own label', () => {
  test('its words and how far it is while it runs; none without words', () => {
    expect(jobLabel({ message: '음성 인식 모델 내려받는 중 (488 MB, 처음 한 번만)', progress: 0.234 })).toBe('음성 인식 모델 내려받는 중 (488 MB, 처음 한 번만) · 23%')
    expect(jobLabel({ message: '받아쓰는 중', progress: null })).toBe('받아쓰는 중')
    expect(jobLabel({ message: null, progress: 0.5 })).toBeNull()
    expect(jobLabel(undefined)).toBeNull()
  })
  test('a job that has not started waits for its turn (TC-154 F1): not "transcribing" yet', () => {
    expect(jobWaiting({ status: 'queued' })).toBe(true)
    expect(jobWaiting({ status: 'running' })).toBe(false)
    expect(jobWaiting({ status: 'done' })).toBe(false)
    expect(jobWaiting(undefined)).toBe(false) // not heard of yet (most jobs start at once): transcribing
  })
})
