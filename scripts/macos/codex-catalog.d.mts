// Types of codex-catalog.mjs (the installer runs the .mjs with the bundle's bun; the tests import it).
export interface CodexModelsCache { models: Record<string, unknown>[]; [k: string]: unknown }
export function lockCatalog(j: CodexModelsCache): CodexModelsCache
