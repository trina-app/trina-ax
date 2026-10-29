import fs from 'node:fs'
import path from 'node:path'
import { spyOn } from 'bun:test'
import { makeCApp } from '../lib/c-app'
import { componentC } from '../../server/src/team-files/component'
import { publishArtifact } from '../../server/src/safe-ops/publication'
import * as native from '../../server/src/safe-ops/broker'
import { snapshot } from '../../server/src/safe-ops/source'
const phase=process.argv[2]!,app=await makeCApp('safe-crash-'+phase)
const c=app.toolCtx('alice',app.turn('alice',app.chat('alice'))),src='users/alice/source.txt'
fs.writeFileSync(path.join(app.team,src),'synthetic source')
const source=snapshot(app.ctx.files,c,src,1024),original=native.broker
spyOn(native,'broker').mockImplementation((root,args,input,cap)=>{
 if(args[0]!=='publish')return original(root,args,input,cap)
 console.log(JSON.stringify({data:app.data,team:app.team,target:args[1],id:args[2]}))
 if(phase==='before') {
  // Simulate a crashed helper's partial private spool. Journal already committed.
  fs.writeFileSync(path.join(root,path.dirname(args[1]!),'.mycel-tmp-safe-'+args[2]),'partial',{mode:0o400,flag:'wx'})
  process.exit(73)
 }
 original(root,args,input,cap)
 process.exit(73)
})
await publishArtifact(app.ctx,componentC(app.ctx).files,c,'users/alice/crash.pptx',Buffer.from('synthetic artifact'),[source],async()=>{})
process.exit(1)
