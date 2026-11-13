- For contributors: every API endpoint and web screen now belongs to a named feature in `docs/features.ts`, and
  `bun run features:check` (in CI) says which feature a new one should join. The e2e run records which endpoints it
  reached, for the QA sheet's new Features tab (docs/FEATURES.md).
