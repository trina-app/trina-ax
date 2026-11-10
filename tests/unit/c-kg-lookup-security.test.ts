// lookup() against the security world (tests/security/lib/world.ts, knowledge-graph-cases.ts): the whole server with
// the real session service, the team built only through the API, the documents part of the knowledge graph on with the
// real document index. For every signed-in persona and every file canary, lookup() (the AI's document search, the lookup
// before the model starts, the Files search) shows nothing the persona may not read, and finds what they may.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { knowledgeGraphOf, openDocumentIndex, setKnowledgeGraphForTests, type KnowledgeGraph } from '../../server/src/knowledge-graph/service'
import { startInstance, type Instance } from '../security/lib/instance'
import { buildWorld, type World } from '../security/lib/world'
import { judgeLookup, lookupCases, type LookupAs } from '../security/lib/knowledge-graph-cases'

setDefaultTimeout(180_000)

let inst: Instance
let W: World
let kg: KnowledgeGraph
beforeAll(async () => {
  setKnowledgeGraphForTests({ runner: null, openDocs: openDocumentIndex, firstCheckMs: null, debounceMs: 50, maxWaitMs: 500, pauseMinMs: 0, pauseMaxMs: 0 })
  try {
    inst = await startInstance('kg-lookup-security')
    kg = knowledgeGraphOf(inst.ctx)
  } finally { setKnowledgeGraphForTests(undefined) }
  W = await buildWorld(inst)
  kg.checkAll()
  await kg.whenIdle()
})
afterAll(async () => { for (const s of Object.values(W?.sockets ?? {})) s.close(); await inst?.close() })

describe('lookup(): every persona x every file canary', () => {
  test('the documents part is on and indexed', () => {
    expect(kg.docsOn()).toBe(true)
    expect(kg.status().documents.documents).toBeGreaterThan(0)
  })
  const lookupAs: LookupAs = (userId, queries, o) => kg.lookup(inst.ctx.files.principal(userId), queries, o)
  test('nothing a persona may not read; what they may read is found', async () => {
    const problems: string[] = []
    for (const k of lookupCases(W)) for (const p of await judgeLookup(k, lookupAs)) problems.push(`${k.label}: ${p}`)
    expect(problems).toEqual([])
  })
})
