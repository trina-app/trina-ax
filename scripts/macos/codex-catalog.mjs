// Locked Codex model catalog for the engine account (design tab 2 "엔진 잠금 (Codex CLI)", tab 3 "Codex 실행 환경").
// Run by scripts/install-macos.sh as root with the bun of the bundle it installs:
//
//   bun codex-catalog.mjs <models_cache.json> <out model_catalog.json>
//
// The source is a models_cache.json a Codex CLI of the same version fetched (the owner's ~/.codex/models_cache.json,
// or --codex-models). Every model gets shell_type "disabled", tool_mode "direct", no node REPL, no experimental
// tools, no apply_patch, no multi-agent and no skills / plugins / apps instructions: the server's catalog gives the
// model an exec tool otherwise (it ran `id` in the 0.163 probe). Must stay the same as writeLockedCatalog() in
// server/src/engine/codex.ts (tests/unit/codex-prod.test.ts compares them). Prints the model slugs (JSON).
import fs from 'node:fs'

export function lockCatalog(j) {
  if (!j || !Array.isArray(j.models) || !j.models.length) throw new Error('not a Codex models cache (no models)')
  j.models = j.models.map((m) => {
    if (!m || typeof m.slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(m.slug)) throw new Error('bad model entry')
    return { ...m, shell_type: 'disabled', tool_mode: 'direct', node_repl_disabled: true, experimental_supported_tools: [],
      multi_agent_version: null, apply_patch_tool_type: null, supports_search_tool: false,
      include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false }
  })
  return j
}

if (import.meta.main) {
  const [src, dst] = process.argv.slice(2)
  if (!src || !dst) { console.error('usage: codex-catalog.mjs <models_cache.json> <out>'); process.exit(2) }
  const st = fs.lstatSync(src)
  if (!st.isFile() || st.size > 16 * 1024 * 1024) { console.error(`${src}: not a regular file of at most 16 MB`); process.exit(1) }
  const j = lockCatalog(JSON.parse(fs.readFileSync(src, 'utf8')))
  fs.writeFileSync(dst, JSON.stringify(j), { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(j.models.map((m) => m.slug)))
}
