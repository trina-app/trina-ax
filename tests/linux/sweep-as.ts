// The git hook sweep of the attack suite as the runner does it: as the server account, not root (an exec-only hook
// cannot be opened for reading by its owner; root could). Argument: {"roots": [...], "visible": {...}} or
// {"entry": "<abs>", "visible": {...}} (Files: sweepEntry). Prints the changed paths as JSON; exit 1 with the
// reason on stderr when the sweep fails.
import { sweepEntry, sweepHooks } from '../../server/src/devenv/srt/hook-sweep'
const a = JSON.parse(process.argv[2] ?? '{}') as { roots?: string[]; entry?: string; visible?: { read: string[]; deny?: string[] } }
try {
  const changed = a.entry ? await sweepEntry(a.entry, { visible: a.visible }) : await sweepHooks(a.roots ?? [], { visible: a.visible })
  console.log(JSON.stringify(changed))
} catch (e) { console.error((e as Error).message); process.exit(1) }
