// Modules the demo build's Vite settings provide (web/demo/vite.ts).
declare module '@demo-content' {
  const script: import('./script').DemoScript
  export default script
}
declare module 'virtual:demo-assets' {
  /** the story's assets/ folder: file name → its built address */
  const urls: Record<string, string>
  export default urls
}
interface ImportMetaEnv {
  /** the end card's sign-up link (default: the story's) */
  readonly VITE_DEMO_SIGNUP_URL?: string
}
