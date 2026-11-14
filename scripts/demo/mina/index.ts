// The hands-on demo story (format: web/demo/script.ts), in English first. Other languages come later as
// strings/<locale>.ts plus their pictures in assets/; see README.md.
import { buildScript } from './story'
import { en } from './strings/en'

export default buildScript(en, 'en')
