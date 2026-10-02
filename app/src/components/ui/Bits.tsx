import {useEffect, useState, type ReactNode} from 'react';

export function Skeleton({className = ''}: {className?: string}) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function Progress({value, tone = 'brass', label}: {value: number; tone?: 'brass' | 'up'; label?: string}) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
      <div
        className={`h-full rounded-full transition-[width] duration-500 ease-[var(--ease-in-out-quart)] ${
          tone === 'up' ? 'bg-up-500' : 'bg-brass-500'
        }`}
        style={{width: `${v}%`}}
      />
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{value: T; label: string; count?: number}>;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="tablist" className="inline-flex rounded-md border border-ink-800 bg-ink-900 p-0.5">
      {options.map(o => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`rounded-[5px] font-medium transition-[background-color,color,transform] duration-150 ease-[var(--ease-out-quart)] ${
              size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm'
            } ${active ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'} active:translate-y-px active:duration-75 focus-visible:outline-2 focus-visible:outline-brass-400`}>
            {o.label}
            {o.count !== undefined && <span className="num ml-1.5 text-[11px] text-ink-500">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Badge({tone = 'ink', children}: {tone?: 'ink' | 'brass' | 'up' | 'down'; children: ReactNode}) {
  const tones = {
    ink: 'bg-ink-800 text-ink-300 border-ink-700',
    brass: 'bg-brass-900 text-brass-300 border-brass-700/50',
    up: 'bg-up-900 text-up-400 border-up-500/30',
    down: 'bg-down-900 text-down-400 border-down-500/30',
  };
  return (
    <span className={`inline-flex h-6 items-center rounded-full border px-2 text-[12px] font-medium ${tones[tone]}`}>{children}</span>
  );
}

export function Empty({title, body, action}: {title: string; body?: string; action?: ReactNode}) {
  return (
    <div className="anim-fade flex flex-col items-center justify-center rounded-lg border border-dashed border-ink-700 px-6 py-14 text-center">
      <Mark className="mb-4 size-8 text-ink-600" />
      <p className="text-base font-medium text-ink-200">{title}</p>
      {body && <p className="measure mt-1 text-sm text-ink-500">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorBox({title, body, retry}: {title: string; body?: string; retry?: () => void}) {
  return (
    <div role="alert" className="anim-fade rounded-lg border border-down-500/40 bg-down-900/40 px-5 py-4">
      <p className="font-medium text-down-400">{title}</p>
      {body && <p className="mt-1 text-sm text-ink-300">{body}</p>}
      {retry && (
        <button onClick={retry} className="mt-3 text-sm text-brass-400 underline-offset-4 hover:underline active:text-brass-300 focus-visible:outline-brass-400">
          Try again
        </button>
      )}
    </div>
  );
}

export function Mark({className = ''}: {className?: string}) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 15V9h6" />
    </svg>
  );
}

/** Toasts: a tiny event bus, one region, stacked, dismissable. */
type Toast = {id: number; tone: 'ok' | 'warn' | 'err'; text: string};
const listeners = new Set<(t: Toast) => void>();
let seq = 0;
export function toast(text: string, tone: Toast['tone'] = 'ok') {
  const t = {id: ++seq, tone, text};
  listeners.forEach(l => l(t));
}

export function ToastRegion() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (t: Toast) => {
      setItems(s => [...s, t]);
      setTimeout(() => setItems(s => s.filter(x => x.id !== t.id)), 4200);
    };
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
      {items.map(t => (
        <div
          key={t.id}
          className={`anim-toast pointer-events-auto flex max-w-md items-center gap-3 rounded-md border px-4 py-2.5 text-sm shadow-lg ${
            t.tone === 'ok'
              ? 'border-up-500/40 bg-ink-900 text-ink-100'
              : t.tone === 'warn'
                ? 'border-warn-500/50 bg-ink-900 text-ink-100'
                : 'border-down-500/50 bg-ink-900 text-ink-100'
          }`}>
          <span
            className={`size-2 shrink-0 rounded-full ${t.tone === 'ok' ? 'bg-up-500' : t.tone === 'warn' ? 'bg-warn-500' : 'bg-down-500'}`}
          />
          {t.text}
          <button
            onClick={() => setItems(s => s.filter(x => x.id !== t.id))}
            className="ml-1 text-ink-500 hover:text-ink-200 focus-visible:outline-brass-400"
            aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
