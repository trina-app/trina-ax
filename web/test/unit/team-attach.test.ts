// lib/teamAttach: handing team files to a composer, the chips a draft keeps while it is not on screen, and sign-out
// forgetting all of it (the next person in the same tab must not see "Add to current chat" aimed at the previous
// person's chat, nor their chips or draft chat).
import { describe, expect, test } from 'bun:test'
import { addToCurrentChat, currentChatTarget, draftChat, draftChatIfAny, forgetTeamAttach, patchStash, readStash, registerComposer, rememberChat, sendToComposer, subscribeStash, writeStash } from '../../src/lib/teamAttach'

describe('teamAttach', () => {
  test('paths queued for a composer that is not on screen reach it when it opens; the result comes back', async () => {
    const r = sendToComposer('c1', ['shared/a.md'])
    const got: string[][] = []
    const off = registerComposer('c1', async (p) => (got.push(p), { added: p.length, failed: 0 }))
    expect(await r).toEqual({ added: 1, failed: 0 })
    expect(got).toEqual([['shared/a.md']])
    off()
  })

  test('the last chat is per person, and sign-out forgets it, the chips and the draft chats', async () => {
    rememberChat('alice', 'chat-a')
    expect(currentChatTarget('alice')).toBe('chat-a')
    expect(currentChatTarget('bob')).toBeNull()
    writeStash('alice', 'new', [{ id: 'x' }])
    await draftChat('alice', 'new', async () => 'chat-new')
    forgetTeamAttach()
    expect(currentChatTarget('alice')).toBeNull()
    expect(addToCurrentChat('bob', ['shared/a.md'], () => {})).toBeNull()
    expect(readStash('alice', 'new')).toEqual([])
    expect(draftChatIfAny('alice', 'new')).toBeNull()
  })

  test('a patch to a chip goes to the composer showing the draft now', () => {
    writeStash('alice', 'c2', [{ id: 'u1', status: 'uploading' }])
    const seen: unknown[] = []
    const off = subscribeStash('alice', 'c2', (items) => seen.push(items))
    patchStash<{ id: string; status: string }>('alice', 'c2', 'u1', { status: 'done' })
    expect(seen).toEqual([[{ id: 'u1', status: 'done' }]])
    expect(readStash('alice', 'c2')).toEqual([{ id: 'u1', status: 'done' }])
    off()
    forgetTeamAttach()
  })
})
