// Runs a standalone Electron fixture (fixtures/*-main.ts) until it prints its `<TAG> {json}` result line, then stops it
// with SIGKILL and returns the parsed JSON. The result line is all a spec needs: Electron's own exit can take minutes on
// a busy Mac or a CI runner (a registered worker, a window that will not close), which said nothing about the test and
// stalled the whole run (the work-files fixture fix, PR #1015). Waiting for the exit is what this replaces.
//
// Every run's stdout and stderr go to e2e/.work/logs/<tag>-<time>.log, which CI uploads when the job fails.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOGS = join(import.meta.dirname, '.work', 'logs')

/** The JSON after `<tag> ` on the first full line that starts with it; fails after `ms` or when the fixture exits first. */
export function fixtureResult<T = any>(cmd: string, args: string[], env: NodeJS.ProcessEnv, tag: string, ms: number): Promise<T> {
  const prefix = `${tag} `
  return new Promise((done, fail) => {
    const started = Date.now()
    const p = spawn(cmd, args, { env })
    let out = ''
    let err = ''
    let settled = false
    const log = (how: string) => {
      try {
        mkdirSync(LOGS, { recursive: true })
        writeFileSync(join(LOGS, `${tag.toLowerCase()}-${started}.log`), `${how} after ${Date.now() - started} ms\n--- stdout\n${out}\n--- stderr\n${err}\n`)
      } catch { /* the log is a help, never the test */ }
    }
    const finish = (how: string, f: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      log(how)
      f()
    }
    const timer = setTimeout(() => {
      p.kill('SIGKILL')
      finish('timed out', () => fail(new Error(`no ${tag} within ${ms} ms\n${err.slice(-2000)}`)))
    }, ms)
    p.stdout.on('data', (b) => {
      out += String(b)
      const at = out.split('\n').findIndex((l) => l.startsWith(prefix))
      // the whole line: it is printed in one write, but a pipe may hand it over in pieces
      if (at < 0 || out.split('\n').length <= at + 1) return
      const line = out.split('\n')[at]!
      p.kill('SIGKILL')
      finish('result', () => {
        try { done(JSON.parse(line.slice(prefix.length)) as T) } catch (e) { fail(e) }
      })
    })
    p.stderr.on('data', (b) => { err += String(b) })
    p.on('error', (e) => finish('spawn error', () => fail(e)))
    p.on('exit', (code, signal) => finish(`exited ${code ?? signal}`, () => fail(new Error(`fixture exited ${code ?? signal} without ${tag}\n${err.slice(-2000)}`))))
  })
}
