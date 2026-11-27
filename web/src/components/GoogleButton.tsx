// The Google button of the sign-in, setup, invite and team link pages, as Google's "Sign in with Google" branding
// guidelines say (https://developers.google.com/identity/branding-guidelines): one of Google's three texts ("Sign in
// with Google", "Sign up with Google", "Continue with Google", in the page's language), the standard colour "G" at its
// own proportions, and Google's button colours: light, white with a #747775 edge and #1F1F1F text; dark, #131314 with
// a #8E918F edge and #E3E3E3 text. 12 px before the mark, 10 px between it and the text, 12 px after the text. The
// guidelines name Google Sans Medium; the app does not load it, so the button uses the app's own font at medium weight.
import { Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'
import clsx from 'clsx'

/** Google's standard colour "G" (the four-colour mark), never recoloured or stretched. */
export function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden focusable="false" className="shrink-0" data-testid="google-mark">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

/** A full-width Google button: the mark, then the label. Busy: a spinner in the mark's place, and off. */
export function GoogleButton({ busy, children, className, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={clsx(
        'flex h-10 w-full items-center justify-center gap-2.5 rounded-lg border pr-3 pl-3 text-sm font-medium whitespace-nowrap transition max-md:min-h-11',
        'border-[#747775] bg-white text-[#1F1F1F] hover:bg-[#F8F9FA]',
        'dark:border-[#8E918F] dark:bg-[#131314] dark:text-[#E3E3E3] dark:hover:bg-[#1F1F21]',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
    >
      {busy ? <Loader2 size={18} className="shrink-0 animate-spin" aria-hidden /> : <GoogleMark />}
      <span className="truncate">{children}</span>
    </button>
  )
}
