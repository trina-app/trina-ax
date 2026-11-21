// Stand-ins for node:fs, node:os, node:path, node:zlib and node:async_hooks in the demo build (web/demo/vite.ts aliases them here). The
// mock server imports them for test fixtures the demo never makes (office samples, a sealing folder); anything that
// would really need them throws.
const no = (what: string) => () => { throw new Error(`demo: ${what} is not available in the browser`) }

export const mkdtempSync = (prefix: string) => prefix
export const readFileSync = no('fs.readFileSync')
export const writeFileSync = no('fs.writeFileSync')
export const rmSync = () => {}
export const existsSync = () => false
export const tmpdir = () => '/tmp'
export const join = (...parts: string[]) => parts.join('/')
export const deflateSync = no('zlib.deflateSync')
/** node:async_hooks for server/src/policy/access.ts (its hidden-folder scope, a module-level `new AsyncLocalStorage`):
 * the page runs one thing at a time, so a store kept for the length of run() is enough. Without it the demo's whole
 * bundle stopped at load ("AsyncLocalStorage is not a constructor"). */
export class AsyncLocalStorage<T> {
  private store: T | undefined
  getStore(): T | undefined { return this.store }
  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const before = this.store
    this.store = store
    try { return fn(...args) } finally { this.store = before }
  }
}
const all = { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, tmpdir, join, deflateSync, AsyncLocalStorage }
export default all
