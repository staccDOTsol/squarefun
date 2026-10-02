import {useEffect, useRef, useState, type ReactNode} from 'react';

/**
 * The pieces that make a live page read as live: a number that rolls and leaves a tint when it
 * changes, a row that drops in when it arrives and jolts when it is big, a bar that fills until
 * the next read, and a strip of the latest things scrolling past.
 *
 * None of them fetch anything. Give them values; they notice the change.
 */

/** Which way `value` last moved, and a key that changes each time it does. */
export function useChange(value: number | bigint | null | undefined) {
  const prev = useRef(value);
  const [change, setChange] = useState<{dir: 'up' | 'down' | null; n: number}>({dir: null, n: 0});
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (value == null || before == null || value === before) return;
    setChange((c) => ({dir: value > before ? 'up' : 'down', n: c.n + 1}));
  }, [value]);
  return change;
}

/**
 * A number that shows it changed: it rolls in from the direction it moved and its cell holds a
 * green or red tint that fades. `value` is what is compared; children are what is shown.
 */
export function Flash({
  value,
  children,
  className = '',
  tint = true,
}: {
  value: number | bigint | null | undefined;
  children: ReactNode;
  className?: string;
  /** false for a number where up is not good news and down is not bad: it rolls but takes no colour */
  tint?: boolean;
}) {
  const {dir, n} = useChange(value);
  const flash = !dir ? '' : tint ? (dir === 'up' ? 'anim-flash-up' : 'anim-flash-down') : 'anim-flash-brass';
  return (
    <span key={n} className={`-mx-1 rounded px-1 ${flash} ${className}`}>
      <span className={dir === 'up' ? 'anim-tick-up' : dir === 'down' ? 'anim-tick-down' : ''}>{children}</span>
    </span>
  );
}

/** How long an arrival keeps its class: long enough for the tint to finish, however often the page re-renders meanwhile. */
const ARRIVAL_MS = 1200;

/**
 * Marks a row that was not there on the last render. Returns the class to put on it: it drops
 * in with a brass tint, and jolts if `big`. Rows present at the first ready render are not
 * announced: pass `ready={false}` while the list is still loading, so the first page of history
 * does not all arrive at once.
 */
export function useArrivals<K>(keys: K[], ready = true) {
  const seen = useRef<Set<K> | null>(null);
  const born = useRef(new Map<K, number>());
  const now = Date.now();
  if (ready && seen.current) for (const k of keys) if (!seen.current.has(k) && !born.current.has(k)) born.current.set(k, now);
  useEffect(() => {
    if (!ready) return;
    seen.current = new Set(keys);
    for (const [k, t] of born.current) if (Date.now() - t > ARRIVAL_MS) born.current.delete(k);
  });
  return (key: K, big = false) => {
    const t = born.current.get(key);
    return t !== undefined && now - t < ARRIVAL_MS ? (big ? 'anim-arrive-big' : 'anim-arrive') : '';
  };
}

/** The time, re-read every `ms`: for a countdown, or a balance that grows between reads. */
export function useNow(ms = 1000, enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}

/** A green dot that pulses while the page is reading the chain, with the time until the next read filling beside it. */
export function Heartbeat({every, beat, label = 'live'}: {every: number; beat: number; label?: string}) {
  return (
    <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-ink-400">
      <span className="relative flex size-2">
        <span className="anim-pulse absolute inline-flex size-full rounded-full bg-up-500 opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-up-500" />
      </span>
      {label}
      <span className="h-[3px] w-10 overflow-hidden rounded-full bg-ink-800" aria-hidden>
        <span
          key={beat}
          className="anim-sweep block h-full rounded-full bg-brass-500"
          style={{['--sweep' as string]: `${every}ms`}}
        />
      </span>
    </span>
  );
}

/** The latest things, scrolling past. Pauses under the pointer. Give it at least a few items. */
export function Ticker({children, seconds = 40}: {children: ReactNode; seconds?: number}) {
  return (
    <div className="overflow-hidden border-y border-ink-800 bg-ink-900/60" role="marquee" aria-live="off">
      <div className="anim-marquee flex w-max gap-8 py-1.5 pr-8 text-[12px]" style={{['--marquee' as string]: `${seconds}s`}}>
        {children}
        {/* the same run again, so the strip can loop without a seam */}
        <span className="contents" aria-hidden>
          {children}
        </span>
      </div>
    </div>
  );
}

/** A place on a leaderboard, and whether it rose or fell since the last read. */
export function Rank({place, was}: {place: number; was?: number}) {
  const moved = was == null || was === place ? null : was > place ? 'up' : 'down';
  return (
    <span className="num inline-flex w-9 items-baseline gap-0.5 text-ink-400">
      <Flash value={-place} className={place <= 3 ? 'text-brass-400' : ''}>
        {place}
      </Flash>
      {moved && <span className={`text-[9px] ${moved === 'up' ? 'text-up-400' : 'text-down-400'}`}>{moved === 'up' ? '▲' : '▼'}</span>}
    </span>
  );
}
