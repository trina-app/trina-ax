import type { Spec } from './cases'
import { leaks } from './matrix'

// Admin > Plugins (docs/PLUGINS.md). Owners and admins only: members, a must-change-password account and signed-out
// visitors are refused before anything is read. Package checks (signatures, archive limits, the approved digest,
// platform, rollback rules) and the lifecycle itself are tested in tests/unit/plugins-*.test.ts; this permanent matrix
// pins the auth level of every route and that unknown plugins and unknown approval tokens are refused for everyone.
const UNKNOWN = 'app.trina.no-such-plugin'
const junk = () => { const f = new FormData(); f.set('file', new File([Buffer.from('not a plugin package')], 'x.trinaplugin')); return f }
export const PLUGIN_SPECS: Record<string, Spec> = {
  listPlugins: {
    build: c => c.get('/api/admin/plugins'), scope: 'byLevel',
    check: (r, _w, who) => { if (r.status === 200 && leaks(who, r.text).length) throw new Error('the plugin list carries something the caller may not see') },
  },
  // a package that does not open: the admin passes the permission check and gets a validation refusal
  inspectPluginFile: { build: c => c.req('POST', '/api/admin/plugins/inspect', undefined, { form: junk() }), scope: 'byLevel' },
  // an id the official list does not have: the admin passes the permission check and gets not_available (a listed id
  // would start a download from the release feed)
  inspectPluginSource: { build: c => c.post('/api/admin/plugins/inspect-source', { source: 'catalog', id: UNKNOWN }), scope: 'byLevel' },
  installPlugin: { build: c => c.post('/api/admin/plugins/install', { token: '00000000-0000-4000-8000-000000000000', manifestSha256: 'a'.repeat(64), enable: true, permissions: [] }), scope: 'nobody' },
  enablePlugin: { build: c => c.post(`/api/admin/plugins/${UNKNOWN}/enable`, {}), scope: 'nobody' },
  disablePlugin: { build: c => c.post(`/api/admin/plugins/${UNKNOWN}/disable`, {}), scope: 'nobody' },
  rollbackPlugin: { build: c => c.post(`/api/admin/plugins/${UNKNOWN}/rollback`, {}), scope: 'nobody' },
  uninstallPlugin: { build: c => c.del(`/api/admin/plugins/${UNKNOWN}`), scope: 'nobody' },
}
