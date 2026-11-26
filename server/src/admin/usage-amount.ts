// The amount of a turn on the usage screens (Admin › Usage, Settings › Usage), in one place for every query (QA TC-3143).
//   amount:     cost_usd (money spent: API keys at the provider's cost or the list price; the engine's own estimate on a
//               local login) + est_cost_usd (subscription sign-ins through the model proxy, at API list prices).
//   estimated:  the turn has a subscription estimate: the screens say "estimated at API prices", not a bill.
//   unpriced:   the turn used tokens and its amount has an unknown part: the API engine's provider sent no cost for a
//               model the price list lacks ('engine_unpriced', also Codex on a local login, which reports no cost), or an
//               older subscription turn from before the estimate (proxy row with tokens, no cost and no estimate).
//               Never shown as a plain $0.
// Budgets do not use this: they count cost_usd only (docs/DECISIONS.md D16).

/** SQL of one turn row `t` */
export const AMOUNT_SQL = '(COALESCE(t.cost_usd, 0) + COALESCE(t.est_cost_usd, 0))'
export const ESTIMATED_SQL = '(COALESCE(t.est_cost_usd, 0) > 0)'
export const UNPRICED_SQL = `(t.usage_source = 'engine_unpriced' OR (t.usage_source = 'proxy' AND t.est_cost_usd IS NULL
  AND COALESCE(t.cost_usd, 0) = 0 AND COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0) > 0))`

/** The aggregate columns of a usage row: turns, tokens, costUsd (the amount above), unpricedTurns, estimatedTurns */
export const USAGE_AGG = `COUNT(*) AS turns, COALESCE(SUM(t.input_tokens), 0) AS inputTokens, COALESCE(SUM(t.output_tokens), 0) AS outputTokens,
  COALESCE(SUM(${AMOUNT_SQL}), 0) AS costUsd, COALESCE(SUM(CASE WHEN ${UNPRICED_SQL} THEN 1 ELSE 0 END), 0) AS unpricedTurns,
  COALESCE(SUM(CASE WHEN ${ESTIMATED_SQL} THEN 1 ELSE 0 END), 0) AS estimatedTurns`

/** The same for one row read in code (Admin › Usage by day) */
export interface TurnAmountRow { input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; est_cost_usd: number | null; usage_source: string | null }
export function turnAmount(r: TurnAmountRow): { usd: number; estimated: boolean; unpriced: boolean } {
  const cost = r.cost_usd ?? 0
  const est = r.est_cost_usd ?? 0
  const tokens = (r.input_tokens ?? 0) + (r.output_tokens ?? 0)
  const unpriced = r.usage_source === 'engine_unpriced' || (r.usage_source === 'proxy' && r.est_cost_usd === null && cost === 0 && tokens > 0)
  return { usd: cost + est, estimated: est > 0, unpriced }
}

/** unpricedTurns / estimatedTurns only when above 0 (the API leaves them out otherwise) */
export function withCounts<T extends { unpricedTurns?: number; estimatedTurns?: number }>(r: T): T {
  if (!r.unpricedTurns) delete r.unpricedTurns
  if (!r.estimatedTurns) delete r.estimatedTurns
  return r
}

/**
 * Usage by model (Settings › Usage, Admin › Usage by model): one row per turn and model that answered it, with the same
 * columns as a turn row, to read `FROM ${TURN_MODEL_ROWS} t` with USAGE_AGG. A turn with turn_models rows (migration 456:
 * what the model proxy or the engine reported per model, never both) gives one row per model; an older turn, or one
 * that reported no model, gives its own row under turns.model (the model asked for; NULL = "default model").
 */
export const TURN_MODEL_ROWS = `(SELECT t.id, t.user_id, t.engine, t.started_at, t.credential_id, t.usage_source, tm.model AS model,
    tm.input_tokens, tm.output_tokens, tm.cost_usd, tm.est_cost_usd
  FROM turns t JOIN turn_models tm ON tm.turn_id = t.id
  UNION ALL
  SELECT t.id, t.user_id, t.engine, t.started_at, t.credential_id, t.usage_source, t.model, t.input_tokens, t.output_tokens, t.cost_usd, t.est_cost_usd
  FROM turns t WHERE NOT EXISTS (SELECT 1 FROM turn_models tm WHERE tm.turn_id = t.id))`
