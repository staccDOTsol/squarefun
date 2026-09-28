import type {InputHTMLAttributes, ReactNode, TextareaHTMLAttributes} from 'react';

interface Common {
  label?: string;
  hint?: string;
  error?: string;
  suffix?: ReactNode;
  mono?: boolean;
}

const shell =
  'w-full rounded-md border bg-ink-900 text-ink-100 placeholder:text-ink-500 ' +
  'transition-[border-color,box-shadow,background-color] duration-150 ease-[var(--ease-out-quart)] ' +
  'hover:border-ink-600 focus:outline-none focus:border-brass-500 focus:shadow-[0_0_0_3px_oklch(0.78_0.16_74/0.18)] ' +
  'disabled:opacity-45 disabled:cursor-not-allowed';

export function Input({label, hint, error, suffix, mono, className = '', id, ...rest}: Common & InputHTMLAttributes<HTMLInputElement>) {
  const inputId = id ?? `f-${label?.toLowerCase().replace(/\s+/g, '-') ?? Math.random().toString(36).slice(2)}`;
  return (
    <label htmlFor={inputId} className="block">
      {label && <span className="mb-1.5 block text-[13px] font-medium text-ink-300">{label}</span>}
      <span className="relative block">
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined}
          className={`${shell} h-11 px-3 ${suffix ? 'pr-16' : ''} ${mono ? 'num' : ''} ${
            error ? 'border-down-500 focus:border-down-500 focus:shadow-[0_0_0_3px_oklch(0.66_0.19_25/0.18)]' : 'border-ink-700'
          } ${className}`}
          {...rest}
        />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[13px] text-ink-400">{suffix}</span>}
      </span>
      {error ? (
        <span id={`${inputId}-err`} role="alert" className="mt-1.5 block text-[13px] text-down-400">
          {error}
        </span>
      ) : hint ? (
        <span id={`${inputId}-hint`} className="mt-1.5 block text-[13px] text-ink-500">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function Textarea({label, hint, error, className = '', id, ...rest}: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const inputId = id ?? `t-${label?.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <label htmlFor={inputId} className="block">
      {label && <span className="mb-1.5 block text-[13px] font-medium text-ink-300">{label}</span>}
      <textarea
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={`${shell} min-h-24 px-3 py-2.5 ${error ? 'border-down-500' : 'border-ink-700'} ${className}`}
        {...rest}
      />
      {error ? (
        <span role="alert" className="mt-1.5 block text-[13px] text-down-400">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1.5 block text-[13px] text-ink-500">{hint}</span>
      ) : null}
    </label>
  );
}
