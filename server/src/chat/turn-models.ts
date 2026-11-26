// Usage by model (turn_models, migration 456): the engine's own report of a turn, per model. The model proxy's count is
// authoritative (credentials/broker.ts record: its first row of a turn replaces these, later ones add to its own);
// these rows are written only while the proxy counted nothing of the turn, so no token is ever counted twice.
import type { Database } from 'bun:sqlite'

export interface ModelTokens { i: number; o: number; c: number }

/** Replace the turn's engine rows with `rows` (the run totals so far, by model), unless the proxy counted the turn.
 * Returns whether it wrote. */
export function writeEngineModelUsage(db: Database, turnId: string, rows: ReadonlyMap<string, ModelTokens>): boolean {
  if (!rows.size) return false
  return db.transaction(() => {
    const proxied = db.query("SELECT 1 FROM turns WHERE id = ? AND usage_source = 'proxy' UNION ALL SELECT 1 FROM turn_models WHERE turn_id = ? AND source = 'proxy' LIMIT 1").get(turnId, turnId)
    if (proxied) return false
    db.query("DELETE FROM turn_models WHERE turn_id = ? AND source = 'engine'").run(turnId)
    const add = db.query(`INSERT INTO turn_models (turn_id, model, source, requests, input_tokens, output_tokens, cost_usd, est_cost_usd) VALUES (?, ?, 'engine', 0, ?, ?, ?, 0)
      ON CONFLICT(turn_id, model) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, cost_usd = cost_usd + excluded.cost_usd`)
    for (const [m, u] of rows) add.run(turnId, m.slice(0, 200), Math.round(u.i), Math.round(u.o), u.c)
    return true
  })()
}
