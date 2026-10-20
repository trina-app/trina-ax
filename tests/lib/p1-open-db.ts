// Child process for p1-migrate-lock.test.ts: open (and migrate) a database, print the result as one JSON line.
import { openDb } from '../../server/src/db'

const [file, dir] = process.argv.slice(2)
try {
  const db = openDb(file!, { migrationsDir: dir })
  const n = (db.query('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n
  db.close()
  console.log(JSON.stringify({ ok: true, applied: n }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }))
}
