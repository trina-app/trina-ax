import fs from 'node:fs'
import path from 'node:path'
import { ToolError } from '../policy/errors'

export const ENVELOPE_MAX = { memory:4*1024**3, pids:512, cpus:4, reserve:640*1024**2 }
// Distinct refusals (QA 2026-10-30 B1): no bounded group at all is an install problem the administrator fixes once
// (`sudo mycel-ctl safe-ops on`); too little free memory in a bounded group is momentary.
const refused=()=>new ToolError('A bounded common engine/server/converter cgroup is required.', 'safe_ops_not_ready_group')
const noHeadroom=()=>new ToolError('The bounded common cgroup has less than 640 MiB of free memory.', 'safe_ops_group_memory')
const outside=()=>new ToolError('The engine process is outside this server\'s cgroup namespace.', 'safe_ops_unavailable')
/** The engine PID comes only from the authenticated turn registry, never tool args.
 * A process outside our cgroup/PID namespace is deliberately unsupported. */
function membership(pid: number) {
  if(!Number.isSafeInteger(pid)||pid<=0) throw outside()
  const rel=fs.readFileSync(`/proc/${pid}/cgroup`,'utf8').split('\n').find(l=>l.startsWith('0::'))?.slice(3)
  if(!rel?.startsWith('/') || rel.split('/').some(s=>s==='..'||s==='.') || path.posix.normalize(rel)!==rel) throw outside()
  return path.join('/sys/fs/cgroup',rel)
}
/** Require a finite common ancestor of the live engine, broker and converter tree.
 * This is an enforced tenant/workflow envelope, not a new per-turn scheduler. */
export function qualifiedEnvelope(converter: string, enginePid: number) {
  try {
    const engine=membership(enginePid), broker=membership(process.pid)
    const inside=(parent:string,child:string)=>child===parent||child.startsWith(parent+'/')
    let common=converter
    while(!inside(common,engine)||!inside(common,broker)) {
      if(common==='/sys/fs/cgroup')throw refused()
      common=path.dirname(common)
      if(!inside('/sys/fs/cgroup',common))throw refused()
    }
    for(let dir=common;;dir=path.dirname(dir)) {
      const read=(f:string)=>fs.readFileSync(path.join(dir,f),'utf8').trim()
      const memory=Number(read('memory.max')),pids=Number(read('pids.max'))
      const cpu=read('cpu.max').split(/\s+/).map(Number)
      if(Number.isFinite(memory)&&memory>0&&memory<=ENVELOPE_MAX.memory&&Number.isFinite(pids)&&pids>0&&pids<=ENVELOPE_MAX.pids&&
         cpu.length===2&&Number.isFinite(cpu[0])&&cpu[0]!>0&&cpu[1]!>0&&cpu[0]!/cpu[1]!<=ENVELOPE_MAX.cpus&&read('memory.swap.max')==='0') {
        const current=Number(read('memory.current'))
        if(!Number.isFinite(current)||current<0)throw refused()
        if(memory-current<ENVELOPE_MAX.reserve)throw noHeadroom()
        return {dir,memory,pids,cpu:cpu[0]!/cpu[1]!,current}
      }
      if(dir==='/sys/fs/cgroup')break
    }
  }catch(e){if(e instanceof ToolError)throw e}
  throw refused()
}
