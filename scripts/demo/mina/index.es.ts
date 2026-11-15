// The hands-on demo story in Spanish (DEMO_LOCALE=es, served at /demo/es/): the same story (story.ts) with the words of
// strings/es.ts and the `.es.` pictures and team files in assets/.
import { buildScript } from './story'
import { es } from './strings/es'

export default buildScript(es, 'es')
