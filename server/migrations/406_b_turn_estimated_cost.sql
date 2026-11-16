-- min_compatible_reader: 1
-- Component B: the estimate of a turn's use on a subscription sign-in (QA TC-3143).
--   turns.est_cost_usd: what the turn's requests on a subscription connection (Claude sign-in, ChatGPT sign-in) would
--     cost at API list prices, summed per request by the model proxy (credentials/broker.ts, priced with the cache
--     split that the turn row does not keep). cost_usd stays the money spent (subscriptions add 0, docs/DECISIONS.md
--     D16), so budgets and connection limits do not change; the usage screens show cost_usd + est_cost_usd and say
--     "estimated at API prices". NULL: nothing was estimated (older rows, API keys, local login).
-- Additive only (reader 1).
ALTER TABLE turns ADD COLUMN est_cost_usd REAL;
