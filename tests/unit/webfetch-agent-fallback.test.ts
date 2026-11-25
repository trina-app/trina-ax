// web_fetch's second User-Agent (QA A-11-M): a site whose firewall drops or refuses the "Mozilla/5.0 (compatible; …)"
// agent (autonomy.work closed the connection without an answer, so the AI wrote a report's figures from search
// summaries) is asked once more with the plain agent, inside the same time limit. A site that refuses both still fails.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { FETCH_AGENTS, webFetch, type FetchOptions } from '../../server/src/tools/web-fetch'

describe('web_fetch: a second try with the plain agent', () => {
  let server: net.Server
  let port = 0
  const seen: string[] = []
  beforeAll(async () => {
    server = net.createServer((s) => {
      s.on('error', () => {})
      s.once('data', (d) => {
        const head = d.toString('latin1')
        const ua = /\r\nUser-Agent: ([^\r]*)/i.exec(head)?.[1] ?? ''
        const path = head.split(' ')[1] ?? '/'
        seen.push(`${path} ${ua}`)
        const ok = (body: string) => s.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
        const status = (n: number) => s.end(`HTTP/1.1 ${n} No\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nno`)
        const browserish = /compatible;/.test(ua)
        if (path === '/drop') return browserish ? s.destroy() : ok('71% of staff reported less burnout')
        if (path === '/forbid') return browserish ? status(403) : ok('the page')
        if (path === '/always-403') return status(403)
        if (path === '/missing') return status(404)
        return ok('root')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
  })
  afterAll(() => { server.close() })
  const T = (): FetchOptions => ({ testAllow: (ip) => ip === '127.0.0.1', lookup: async () => [{ address: '127.0.0.1', family: 4 }], timeoutMs: 5000 })
  const U = (p: string) => `http://fetch.test:${port}${p}`
  const tries = (p: string) => seen.filter((l) => l.startsWith(`${p} `))

  test('the agents: the first as before, the second without the "compatible" form', () => {
    expect(FETCH_AGENTS[0]).toMatch(/^Mozilla\/5\.0 \(compatible; /)
    expect(FETCH_AGENTS[1]).not.toMatch(/Mozilla|compatible/)
    expect(FETCH_AGENTS[1]).toMatch(/-fetch\/1\.0 \(\+https:\/\//)
  })

  test('a site that drops the connection for the first agent answers the second', async () => {
    const r = await webFetch(U('/drop'), T())
    expect(r.text).toBe('71% of staff reported less burnout')
    expect(tries('/drop').map((l) => l.split(' ').slice(1).join(' '))).toEqual([...FETCH_AGENTS])
  })

  test('a 403 for the first agent: the second agent\'s page', async () => {
    expect((await webFetch(U('/forbid'), T())).text).toBe('the page')
    expect(tries('/forbid')).toHaveLength(2)
  })

  test('a site that refuses both agents still fails with its own status', async () => {
    await expect(webFetch(U('/always-403'), T())).rejects.toThrow('the site answered HTTP 403')
    expect(tries('/always-403')).toHaveLength(2)
  })

  test('a page that is not there, or a page that opens, is asked once', async () => {
    await expect(webFetch(U('/missing'), T())).rejects.toThrow('HTTP 404')
    expect(tries('/missing')).toHaveLength(1)
    await webFetch(U('/ok'), T())
    expect(tries('/ok')).toHaveLength(1)
  })
})
