// A room named by its id in a text (lib/roomNames.ts, components/RoomNames.tsx; docs/DECISIONS.md "A scheduled task's
// instruction names rooms by their names"): a scheduled task the AI made writes "… room_id <id>"; the Scheduled pages
// and the run's question read it as "#<room name>" (a 1:1 chat: the other person's name) for a viewer in that room, and
// as "a conversation you're not in" for anyone else, who never gets the name (not even one a "#" token carries).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { roomRefToken } from '@mycel/shared/api'
import { roomNameParts, type SeenRoom } from '../../src/lib/roomNames'
import { WithRoomNames } from '../../src/components/RoomNames'
import { UserText } from '../../src/components/chat/Messages'
import { translate } from '../../src/i18n'
import { useRooms } from '../../src/store/rooms'
import { room } from './rooms-fixtures'
import { installDom, mount, removeDom } from './dom-host'

const SALES = '019a7d10-0c2e-7b1c-9d2e-000000000001'
const HR = '019a7d10-0c2e-7b1c-9d2e-000000000002'
const DM = '019a7d10-0c2e-7b1c-9d2e-000000000003'
const FILE = '019a7d10-0c2e-7b1c-9d2e-0000000000ff'
const mine: Record<string, SeenRoom> = { [SALES]: { name: '영업팀', dm: false }, [DM]: { name: '김소라', dm: true } }
const seen = (id: string) => mine[id] ?? null
const notIn = translate('en', 'rooms.roomNotIn')
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')

afterEach(() => { useRooms.setState({ rooms: [], loaded: false, failed: null }) })

describe('room ids in a text', () => {
  test('every form the AI writes a room in is found, by its id', () => {
    for (const written of [`room_id ${SALES}`, `room_id=${SALES}`, `room_id: ${SALES}`, `room id ${SALES}`, `roomId ${SALES}`, `room:${SALES}`, `[#room room_id=${SALES}]`, roomRefToken(SALES, 'Sales'), `ROOM_ID ${SALES.toUpperCase()}`]) {
      expect(roomNameParts(`Summarise ${written} every week.`, seen)).toEqual([{ text: 'Summarise ' }, { room: { id: SALES, name: '영업팀', dm: false } }, { text: ' every week.' }])
    }
  })

  test('a 1:1 chat is named by the other person', () => {
    expect(roomNameParts(`room_id ${DM}`, seen)).toEqual([{ room: { id: DM, name: '김소라', dm: true } }])
  })

  test('access: a room the viewer is not in is never named, also when a token carries its name', () => {
    expect(roomNameParts(`Read room_id ${HR}.`, seen)).toEqual([{ text: 'Read ' }, { room: { id: HR, name: null, dm: false } }, { text: '.' }])
    const token = roomNameParts(`Read ${roomRefToken(HR, '인사 평가')}.`, seen)
    expect(token).toEqual([{ text: 'Read ' }, { room: { id: HR, name: null, dm: false } }, { text: '.' }])
    expect(JSON.stringify(token)).not.toContain('인사 평가')
  })

  test('a bare id is a room only when it is one of the viewer\'s; anything else stays as written', () => {
    expect(roomNameParts(`see ${SALES} and file ${FILE}`, seen)).toEqual([{ text: 'see ' }, { room: { id: SALES, name: '영업팀', dm: false } }, { text: ` and file ${FILE}` }])
    // part of a longer token: not an id
    expect(roomNameParts(`x${SALES}0`, seen)).toEqual([{ text: `x${SALES}0` }])
  })

  test('an id in a web address, a path or a query stays as written (a copied link still works)', () => {
    for (const written of [`https://acme.example/rooms/${SALES}`, `https://acme.example/r?room_id=${SALES}&x=1`, `users/${SALES}/notes.md`, `/api/x?room_id=${SALES}`, `?room=${SALES}`, `a.${SALES}`])
      expect(roomNameParts(`see ${written} now`, seen)).toEqual([{ text: `see ${written} now` }])
  })

  test('long runs of spaces cost no more than short ones (every chat bubble is read for ids)', () => {
    const hostile = `${SALES} ${'room id' + ' '.repeat(20_000) + 'x'}`.repeat(20)
    const t0 = performance.now()
    roomNameParts(hostile, seen)
    expect(performance.now() - t0).toBeLessThan(500)
  })

  test('before the viewer\'s rooms are known: ids stay as written, a token\'s name is held back', () => {
    expect(roomNameParts(`room_id ${SALES}`, undefined)).toEqual([{ text: `room_id ${SALES}` }])
    const token = roomNameParts(roomRefToken(HR, '인사 평가'), undefined)
    expect(token).toEqual([{ room: { id: HR, name: undefined, dm: false } }])
  })

  test('a token the person picked in a chat keeps the title it was picked by (tokenTitles)', () => {
    expect(roomNameParts(roomRefToken(HR, '인사'), seen, { tokenTitles: true })).toEqual([{ room: { id: HR, name: '인사', dm: false, picked: true } }])
  })
})

describe('shown to a viewer', () => {
  // the room list is the app's store: rendered for real (a static render reads a store's first state)
  beforeAll(() => installDom())
  afterAll(() => removeDom())
  const shown = async (ui: ReactNode) => { const m = await mount(ui); try { return decode(m.html()) } finally { await m.unmount() } }
  const rooms = () => [room({ id: SALES, name: '영업팀' }), room({ id: DM, kind: 'dm', name: null, groupId: null, peers: [{ id: 'sora', name: '김소라' }] })]

  test('in the room: "#name" (a 1:1 chat: the person); not in it: the neutral words, never the name', async () => {
    useRooms.setState({ rooms: rooms(), loaded: true, failed: null })
    const html = await shown(<WithRoomNames text={`Summarise room_id ${SALES}, ${roomRefToken(HR, '인사 평가')} and room_id ${DM}.`} />)
    expect(html).toContain('>#영업팀<')
    expect(html).toContain('>김소라<')
    expect(html).toContain(notIn)
    expect(html).toContain('data-room="out"')
    expect(html).not.toContain('인사 평가')
    expect(html).not.toContain(SALES)
    expect(html).not.toContain(HR)
  })

  test('a viewer who left the room (it is no longer in their list) reads the neutral words', async () => {
    useRooms.setState({ rooms: [], loaded: true, failed: null })
    const html = await shown(<WithRoomNames text={`Summarise room_id ${SALES} weekly`} />)
    expect(html.replace(/<[^>]+>/g, '')).toBe(`Summarise ${notIn} weekly`)
    expect(html).not.toContain('영업팀')
  })

  test('the room list could not be read: the text as stored, no claim either way, and no token name', async () => {
    useRooms.setState({ rooms: rooms(), loaded: true, failed: new Error('offline') })
    const html = await shown(<WithRoomNames text={`room_id ${SALES} ${roomRefToken(HR, '인사 평가')}`} />)
    expect(html).toContain(`room_id ${SALES}`)
    expect(html).toContain('data-room="unknown"')
    expect(html).not.toContain('인사 평가')
    expect(html).not.toContain(notIn)
  })

  test('a run\'s question (the chat bubble): the id reads as the name; a token the person picked keeps its chip', async () => {
    useRooms.setState({ rooms: rooms(), loaded: true, failed: null })
    const html = await shown(<UserText content={`Weekly: summarise room_id ${SALES}. Also ${roomRefToken(HR, '인사')}`} clamp={false} />)
    expect(html).toContain('>#영업팀<')
    expect(html).not.toContain(SALES)
    // the person's own "#" pick: as before (components/chat/RoomRefMenu.tsx WithRoomRefs)
    expect(html).toContain('data-testid="room-ref-chip"')
    expect(html).toContain('>#인사<')
  })
})
