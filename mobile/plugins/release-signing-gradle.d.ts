/** Adds the environment-driven release signingConfig to android/app/build.gradle (idempotent; throws on an unknown layout). */
export function applyReleaseSigning(gradle: string): string
