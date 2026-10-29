import {afterEach, expect, test} from 'bun:test'
import {fetchFileBlob, isApiError} from '../../src/lib/api'
const original=globalThis.fetch
afterEach(()=>{globalThis.fetch=original})
test('preview fetch identifies itself and never returns quarantined bytes to a client parser',async()=>{
 let requested=''
 globalThis.fetch=(async(input:any)=>{
  requested=String(input)
  return Response.json({error:{code:'unavailable',message:'Download only',params:{reason:'quarantined'}}},{status:503})
 }) as typeof fetch
 let rejected=false
 try {await fetchFileBlob('shared/generated.pptx')}catch(e){rejected=isApiError(e,'unavailable')&&e.body.params?.reason==='quarantined'}
 expect(rejected).toBe(true)
 expect(new URL(requested,'http://local').searchParams.get('preview')).toBe('true')
})
