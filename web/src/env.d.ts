declare const __WEB_VERSION__: string
declare const __WEB_BUILD__: string

/** the emoji picker's data, made at build time (scripts/emoji-data.ts) */
declare module 'virtual:emoji/*' {
  const lines: string
  export default lines
}
