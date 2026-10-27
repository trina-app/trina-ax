// Minimal SQLite interface for the registry. The relay runs on Node 26 (24+, node:sqlite); unit tests run the same code
// in Bun (bun:sqlite). Positional parameters only, so both drivers behave the same.
import fs from 'node:fs'
import path from 'node:path'

export type SqlValue = string | number | bigint | null
export interface SqlStatement {
  run(...params: SqlValue[]): unknown
  get(...params: SqlValue[]): Record<string, unknown> | undefined
  all(...params: SqlValue[]): Record<string, unknown>[]
}
export interface SqlDb {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

/** Open (and create) a database file; ':memory:' for tests. */
export async function openSqlite(file: string): Promise<SqlDb> {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (process.versions.bun) {
    const { Database } = await import('bun:sqlite')
    const db = new Database(file, { create: true })
    return {
      exec: (sql) => { db.exec(sql) },
      prepare(sql) {
        const st = db.prepare(sql)
        return {
          run: (...p) => st.run(...(p as never[])),
          get: (...p) => (st.get(...(p as never[])) as Record<string, unknown> | null) ?? undefined,
          all: (...p) => st.all(...(p as never[])) as Record<string, unknown>[],
        }
      },
      close: () => db.close(),
    }
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const st = db.prepare(sql)
      return {
        run: (...p) => st.run(...p),
        get: (...p) => st.get(...p) as Record<string, unknown> | undefined,
        all: (...p) => st.all(...p) as Record<string, unknown>[],
      }
    },
    close: () => db.close(),
  }
}

export function tx<T>(db: SqlDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
