// Client of the box helper mycel-boxd (native/cmd/mycel-boxd; wire format shared/src/dev-env.ts). The server never
// runs podman itself: boxd owns every box. The socket path comes from MYCEL_BOXD_SOCK (the experiment has no
// installer step yet); tests replace the whole client with setBoxdClient.
import net from 'node:net'
import { BoxdError, BoxdExit, BoxdNetlog, BoxdOk, BoxdPreview, BoxdPs, BoxdStatus, type BoxdRequest } from '@mycel/shared'
import { connectUnix } from '../system/sockets'

export type BoxdResult<T> = { ok: true; value: T } | { ok: false; message: string }

export interface BoxdClient {
  status(): Promise<BoxdResult<import('@mycel/shared').BoxdStatus>>
  ensure(req: Omit<Extract<BoxdRequest, { op: 'ensure' }>, 'op'>): Promise<BoxdResult<import('zod').infer<typeof BoxdOk>>>
  stop(box: string, destroy?: boolean): Promise<BoxdResult<unknown>>
  exec(req: Omit<Extract<BoxdRequest, { op: 'exec' }>, 'op'>, signal?: AbortSignal): Promise<BoxdResult<import('@mycel/shared').BoxdExit>>
  ps(box: string): Promise<BoxdResult<import('zod').infer<typeof BoxdPs>>>
  /** the unix socket that reaches the dev server port in the box (preview gateway) */
  preview(box: string, port: number): Promise<BoxdResult<import('zod').infer<typeof BoxdPreview>>>
  /** optional: new connections of the box (older helpers and fakes may not have it) */
  netlog?(box: string): Promise<BoxdResult<import('zod').infer<typeof BoxdNetlog>>>
}

/** One request, one reply line (the first line that parses); closing the connection stops an exec in boxd. */
function call(sock: string, req: BoxdRequest, timeoutMs: number, signal?: AbortSignal): Promise<{ line: unknown } | { fail: string }> {
  return new Promise((res) => {
    let c: net.Socket | null = null, b = '', done = false
    const finish = (r: { line: unknown } | { fail: string }) => {
      if (done) return
      done = true; clearTimeout(t); signal?.removeEventListener('abort', onAbort)
      c?.destroy(); res(r)
    }
    const onAbort = () => finish({ fail: 'stopped' })
    const t = setTimeout(() => finish({ fail: 'boxd did not answer in time' }), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    connectUnix(sock, (s) => {
      c = s
      s.on('error', () => finish({ fail: 'boxd unreachable' })); s.on('close', () => finish({ fail: 'boxd closed the connection' }))
      s.setEncoding('utf8')
      s.on('connect', () => s.write(JSON.stringify(req) + '\n'))
      s.on('data', (d: string) => {
        b += d
        const i = b.indexOf('\n')
        if (i < 0) return
        try { finish({ line: JSON.parse(b.slice(0, i)) }) } catch { finish({ fail: 'bad answer from boxd' }) }
      })
    })
  })
}

function parse<T>(r: { line: unknown } | { fail: string }, schema: import('zod').ZodType<T>): BoxdResult<T> {
  if ('fail' in r) return { ok: false, message: r.fail }
  const e = BoxdError.safeParse(r.line)
  if (e.success) return { ok: false, message: e.data.message }
  const v = schema.safeParse(r.line)
  return v.success ? { ok: true, value: v.data } : { ok: false, message: 'bad answer from boxd' }
}

export function socketBoxd(sock: string): BoxdClient {
  return {
    async status() { return parse(await call(sock, { op: 'status' }, 5000), BoxdStatus) },
    async ensure(req) { return parse(await call(sock, { op: 'ensure', ...req }, 120_000), BoxdOk) },
    async stop(box, destroy) { return parse(await call(sock, { op: destroy ? 'destroy' : 'stop', box }, 60_000), BoxdOk) },
    async exec(req, signal) { return parse(await call(sock, { op: 'exec', ...req }, req.timeoutMs + 30_000, signal), BoxdExit) },
    async ps(box) { return parse(await call(sock, { op: 'ps', box }, 10_000), BoxdPs) },
    async preview(box, port) { return parse(await call(sock, { op: 'preview', box, port }, 15_000), BoxdPreview) },
    async netlog(box) { return parse(await call(sock, { op: 'netlog', box }, 10_000), BoxdNetlog) },
  }
}

let override: BoxdClient | null = null
/** tests: a fake box helper */
export function setBoxdClient(c: BoxdClient | null) { override = c }
export function boxd(env: Record<string, string | undefined> = process.env): BoxdClient | null {
  if (override) return override
  const sock = env.MYCEL_BOXD_SOCK
  return sock ? socketBoxd(sock) : null
}
