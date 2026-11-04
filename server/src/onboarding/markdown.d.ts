// Markdown imported as text (`import x from './a.md' with { type: 'text' }`): Bun inlines it into the release bundle,
// so the recommended skill packs (resources/skill-packs) need no extra files in a bundle (onboarding/skill-packs.ts).
declare module '*.md' {
  const text: string
  export default text
}
