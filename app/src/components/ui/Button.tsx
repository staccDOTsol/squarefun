import type {ButtonHTMLAttributes, ReactNode} from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'up' | 'down';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium select-none ' +
  'transition-[background-color,color,border-color,transform,box-shadow] duration-150 ease-[var(--ease-out-quart)] ' +
  'active:translate-y-px active:duration-75 ' +
  'disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass-400';

const variants: Record<Variant, string> = {
  primary:
    'bg-brass-500 text-ink-950 hover:bg-brass-400 active:bg-brass-600 ' +
    'shadow-[0_1px_0_0_oklch(1_0_0/0.25)_inset]',
  secondary: 'bg-ink-800 text-ink-100 border border-ink-700 hover:bg-ink-700 hover:border-ink-600 active:bg-ink-850',
  ghost: 'bg-transparent text-ink-300 hover:bg-ink-850 hover:text-ink-100 active:bg-ink-800',
  up: 'bg-up-500 text-ink-950 hover:bg-up-400 active:bg-up-500',
  down: 'bg-down-500 text-ink-950 hover:bg-down-400 active:bg-down-500',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
};

export function Button({variant = 'primary', size = 'md', loading, disabled, className = '', children, ...rest}: Props) {
  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}>
      {loading && <Spinner />}
      <span className={loading ? 'opacity-70' : ''}>{children}</span>
    </button>
  );
}

export function Spinner({className = ''}: {className?: string}) {
  return (
    <svg className={`size-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
