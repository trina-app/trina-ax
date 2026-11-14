// The demo's start (after web/demo/main.tsx put the bridge in place): the story's server, the worker for pictures, the
// story's words on Home's welcome card, then the real app and the guide line. Every tab is a fresh copy: a reload
// starts the story again at Home.
import './shims/bun'
import script from '@demo-content'
import assetUrls from 'virtual:demo-assets'
import { DICTS, loadLocale, type MessageKey } from '../src/i18n'
import { startWorker } from './bridge'
import { DemoServer } from './server'

export async function boot(made: (s: DemoServer) => void) {
  // a reload starts over: Home, and nothing kept from the last run in this tab
  try { sessionStorage.clear() } catch { /* storage blocked */ }
  if (location.pathname !== '/' || location.search) history.replaceState(null, '', '/')
  const assets: Record<string, Uint8Array> = Object.fromEntries(await Promise.all(Object.entries(assetUrls).map(async ([name, url]) => [name, new Uint8Array(await (await fetch(url)).arrayBuffer())])))
  const server = new DemoServer(script, assets)
  made(server)
  await startWorker()
  // Home's welcome card says the story's welcome, and its one button sends the story's first question
  await loadLocale(script.locale)
  const words = DICTS[script.locale] as Record<MessageKey, string>
  words['memberWelcome.title'] = script.home.title
  words['memberWelcome.ask'] = script.home.prompt
  words['memberWelcome.askHint'] = ''
  words['memberWelcome.askQuestion'] = script.home.prompt
  words['memberWelcome.askButton'] = script.home.button ?? script.home.prompt
  if (script.home.subtitle) { words['memberWelcome.invited'] = script.home.subtitle; words['memberWelcome.people'] = script.home.subtitle }
  await import('../src/main')
  const { mountOverlay } = await import('./overlay')
  mountOverlay(server, import.meta.env.VITE_DEMO_SIGNUP_URL || script.end.signup.url)
  server.engine.fire({ start: true })
}
