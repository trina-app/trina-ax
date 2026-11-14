// The hands-on demo story in Korean (DEMO_LOCALE=ko, served at /demo/ko/): the same story (story.ts) with the words of
// strings/ko.ts and the `.ko.` pictures and team files in assets/.
import { buildScript } from './story'
import { ko } from './strings/ko'

export default buildScript(ko, 'ko')
