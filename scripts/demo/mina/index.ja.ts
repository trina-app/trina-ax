// The hands-on demo story in Japanese (DEMO_LOCALE=ja, served at /demo/ja/): the same story (story.ts) with the words
// of strings/ja.ts and the `.ja.` pictures and team files in assets/.
import { buildScript } from './story'
import { ja } from './strings/ja'

export default buildScript(ja, 'ja')
