// Stand-ins for node:fs, node:os, node:path and node:zlib in the demo build (web/demo/vite.ts aliases them here). The
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
const all = { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, tmpdir, join, deflateSync }
export default all
