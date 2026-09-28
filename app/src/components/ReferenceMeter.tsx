import {nextReferenceLabel, referenceFeeBps} from '../lib/fee';

/**
 * The product, on screen: how many times this token has been referenced in
 * the current block and what the next reference pays. Free means you are the
 * first; anything else means a machine is already in this window with you.
 */
export function ReferenceMeter({refs, compact, freeRefs = 1}: {refs: number; compact?: boolean; freeRefs?: 1 | 2}) {
  const next = nextReferenceLabel(refs, freeRefs);
  const hot = refs > freeRefs;
  if (compact) {
    return (
      <span
        className={`num inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${
          refs === 0
            ? 'border-ink-700 text-ink-400'
            : hot
              ? 'border-down-500/40 bg-down-900/50 text-down-400'
              : 'border-warn-500/40 bg-ink-900 text-warn-500'
        }`}
        title={`${refs} reference${refs === 1 ? '' : 's'} this window; next pays ${next}`}>
        <span className={`size-1.5 rounded-full ${refs === 0 ? 'bg-ink-600' : hot ? 'bg-down-500' : 'bg-warn-500'}`} />
        {refs === 0 ? 'quiet' : `${refs} in block · next ${next}`}
      </span>
    );
  }
  const bars = Array.from({length: 8}, (_, i) => i + 1);
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-[13px] font-medium text-ink-300">This window</p>
        <p className={`num text-[13px] ${hot ? 'text-down-400' : refs ? 'text-warn-500' : 'text-ink-400'}`}>
          {refs} reference{refs === 1 ? '' : 's'}
        </p>
      </div>
      <div className="mt-3 flex items-end gap-1" aria-hidden>
        {bars.map(k => {
          const bps = referenceFeeBps(k, freeRefs);
          const h = 6 + Math.min(100, bps / 10) * 0.34;
          const lit = k <= refs;
          const next = k === refs + 1;
          return (
            <div
              key={k}
              className={`flex-1 rounded-sm transition-[height,background-color] duration-300 ease-[var(--ease-out-quart)] ${
                next ? 'bg-brass-500' : lit ? (k >= 3 ? 'bg-down-500' : 'bg-warn-500') : 'bg-ink-800'
              }`}
              style={{height: `${h}px`}}
              title={`${k}${k === 1 ? 'st' : k === 2 ? 'nd' : k === 3 ? 'rd' : 'th'} reference: ${bps === 0 ? 'free' : `${bps} bp`}`}
            />
          );
        })}
      </div>
      <p className="mt-3 text-sm text-ink-200">
        Your trade lands as reference <span className="num text-brass-400">#{refs + 1}</span> and pays{' '}
        <span className="num font-medium text-brass-300">{next}</span>.
      </p>
      <p className="mt-1 text-[13px] text-ink-500">
        {refs === 0
          ? 'Nobody has touched this token in the current window. The first reference is free. On Robinhood a window is one Ethereum block, about twelve seconds.'
          : 'Someone is already in this window. Wait one block and it resets to free.'}
      </p>
    </div>
  );
}
