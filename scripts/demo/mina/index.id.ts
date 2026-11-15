// The hands-on demo story in Bahasa Indonesia (DEMO_LOCALE=id, served at /demo/id/): the same story (story.ts) with
// the words of strings/id.ts and the `.id.` pictures and team files in assets/.
import { buildScript } from './story'
import { id } from './strings/id'

export default buildScript(id, 'id')
