// The model proxy's internal Bun.serve on a fixed port (engine.proxyInnerPort; ProxyOpts.innerPort). demo-gate's Linux
// firewall (demo-gate/linux/trina-demo.nft) allows the instance user only the instance port range on loopback; the
// gate gives each instance three ports there (listen, proxy, inner), so the inner server must bind the one it is given.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { startModelProxy } from '../../server/src/proxy/model-proxy'
import { ModelProxyService } from '../../server/src/proxy/subscription'
import { ConfigError, loadAppConfig } from '../../server/src/app-config'

const env = makeEnv('unit-proxy-inner-port')

/** a port nothing listens on right now */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = net.createServer()
    s.once('error', fail)
    s.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)) })
  })
}
const listening = (port: number) => new Promise<boolean>((ok) => {
  const c = net.connect(port, '127.0.0.1')
  c.once('connect', () => { c.destroy(); ok(true) })
  c.once('error', () => ok(false))
})
const post = (port: number) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

describe('model proxy inner port', () => {
  test('binds the given port; reaching it directly is refused, through the front it answers', async () => {
    const innerPort = await freePort()
    const p = await startModelProxy({ db: env.db, broker: null, innerPort })
    try {
      expect(p.port).not.toBe(innerPort)
      const direct = await post(innerPort)
      expect(direct.status).toBe(403)
      expect(((await direct.json()) as { error: { message: string } }).error.message).toBe('not through the model proxy port')
      expect((await post(p.port)).status).toBe(401) // the proxy itself: no turn token
    } finally { await p.stop() }
    expect(await listening(innerPort)).toBe(false) // stopped with the proxy
  })

  test('a taken inner port: the start fails and the front port is not left open', async () => {
    const squatter = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('squat') })
    const front = await freePort()
    try {
      await expect(startModelProxy({ db: env.db, broker: null, port: front, innerPort: squatter.port! })).rejects.toThrow()
      expect(await listening(front)).toBe(false)
    } finally { squatter.stop(true) }
  })

  test('without one the OS picks it, as before', async () => {
    const p = await startModelProxy({ db: env.db, broker: null })
    try { expect((await post(p.port)).status).toBe(401) } finally { await p.stop() }
  })

  test('the proxy service passes it on', async () => {
    const [port, innerPort] = [await freePort(), await freePort()]
    const svc = new ModelProxyService({ db: env.db, port, innerPort, broker: null, secretsDir: env.fx.data, log: { info() {}, warn() {} } }).start()
    await svc.started
    try {
      expect(svc.ready).toBe(true)
      expect((await post(innerPort)).status).toBe(403)
    } finally { svc.stop() }
  })
})

describe('engine.proxyInnerPort in server.json', () => {
  const write = (engine: Record<string, unknown>) => {
    const file = path.join(env.fx.data, `server-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(file, JSON.stringify({ mode: 'dev', engine: { authMode: 'managed', ...engine } }))
    return file
  }
  test('read when set, absent otherwise', () => {
    expect(loadAppConfig({ argv: ['--config', write({ proxyPort: 19201, proxyInnerPort: 19202 })], env: {} }).engine.proxyInnerPort).toBe(19202)
    expect(loadAppConfig({ argv: ['--config', write({ proxyPort: 19201 })], env: {} }).engine.proxyInnerPort).toBeUndefined()
  })
  test('a port out of range is refused', () => {
    for (const bad of [0, 65536, 1.5, '19202']) expect(() => loadAppConfig({ argv: ['--config', write({ proxyInnerPort: bad })], env: {} })).toThrow(ConfigError)
  })
})
