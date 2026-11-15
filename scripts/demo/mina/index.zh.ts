// The hands-on demo story in Simplified Chinese (DEMO_LOCALE=zh, served at /demo/zh/): the same story (story.ts) with
// the words of strings/zh.ts and the `.zh.` pictures and team files in assets/.
import { buildScript } from './story'
import { zh } from './strings/zh'

export default buildScript(zh, 'zh')
