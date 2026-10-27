import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AppContext } from '../context'
export interface PushConfig { enabled: true; subject: string; publicKey: string; privateKey: string }
const schema=z.object({enabled:z.literal(true),subject:z.string().max(2048).refine(s=>!/[\r\n]/.test(s)&&(/^(mailto:[^\s@]+@[^\s@]+)$/.test(s)||/^https:\/\//.test(s))),publicKey:z.string().max(128),privateKey:z.string().max(64)}).strict()
export const pushConfigPath=(ctx:AppContext)=>path.join(ctx.config.dataDir,'secrets','push.json')
export const pushConfigKey=(config:PushConfig)=>crypto.createHash('sha256').update(config.publicKey+'|'+config.subject).digest('hex')
/** No auto provisioning. Missing/unsafe/off config means no subscription or outbound connection. */
export function readPushConfig(ctx:AppContext):PushConfig|null {
  try {
    const file=pushConfigPath(ctx), real=fs.realpathSync(file), team=fs.realpathSync(ctx.config.teamRoot)
    if(real===team||real.startsWith(team+path.sep))return null
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
    try {
      const s=fs.fstatSync(fd)
      if(!s.isFile()||s.nlink!==1||s.size>8192||(s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))return null
      const config=schema.parse(JSON.parse(fs.readFileSync(fd,'utf8')))
      const ec=crypto.createECDH('prime256v1');ec.setPrivateKey(Buffer.from(config.privateKey,'base64url'))
      if(ec.getPublicKey().toString('base64url')!==config.publicKey)return null
      return config
    } finally {fs.closeSync(fd)}
  } catch {return null}
}
