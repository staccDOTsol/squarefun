import type {Launch} from '../lib/types';
import {ago, eth, pct, short} from '../lib/format';
import {Link} from '../lib/router';
import {Badge, Progress, Skeleton} from './ui/Bits';
import {ReferenceMeter} from './ReferenceMeter';
import {Flash} from './ui/Live';

export function TokenImage({l, className = ''}: {l: Pick<Launch, 'image' | 'symbol'>; className?: string}) {
  if (l.image) {
    return <img src={l.image} alt="" loading="lazy" className={`shrink-0 rounded-md bg-ink-800 object-cover ${className}`} />;
  }
  return (
    <div className={`num flex shrink-0 items-center justify-center rounded-md bg-ink-800 text-ink-500 ${className}`} aria-hidden>
      {l.symbol.slice(0, 3)}
    </div>
  );
}

export function TokenCard({l, index = 0}: {l: Launch; index?: number}) {
  const progress = Math.min(100, l.graduationThreshold ? (l.quoteReserve / l.graduationThreshold) * 100 : 0);
  const graduated = l.phase === 'pool';
  const viaPools = l.kind === 'pools';
  return (
    <Link
      to={`/t/${l.token}`}
      className="anim-rise group block rounded-lg border border-ink-800 bg-ink-900 p-3 transition-[border-color,transform,box-shadow] duration-200 ease-[var(--ease-out-quart)] hover:-translate-y-0.5 hover:border-ink-600 hover:shadow-[0_8px_24px_-12px_oklch(0_0_0/0.8)] active:translate-y-0 active:border-brass-700/60 active:duration-75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass-400"
      style={{animationDelay: `${Math.min(index, 11) * 30}ms`}}>
      <div className="flex gap-3">
        <TokenImage l={l} className="size-16 text-sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-semibold leading-tight text-ink-100 group-hover:text-brass-300">
                {l.name} <span className="num text-[12px] font-normal text-ink-500">${l.symbol}</span>
              </p>
              <p className="truncate text-[13px] text-ink-400">{l.description}</p>
            </div>
            {viaPools ? <Badge tone="brass">pools.xyz</Badge> : graduated ? <Badge tone="brass">graduated</Badge> : l.phase === 'swept' ? <Badge>sweeping</Badge> : null}
          </div>
          <div className="num mt-2 flex items-center gap-3 text-[12px] text-ink-400">
            <span>
              <span className="text-ink-500">mc</span>{' '}
              <Flash value={l.marketCapEth} className="text-ink-200">
                {eth(l.marketCapEth)}
              </Flash>
            </span>
            <span>
              <span className="text-ink-500">by</span> {short(l.creator, 3)}
            </span>
            <span className="ml-auto text-ink-500">{ago(l.createdAt)}</span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="flex-1">
          <Progress value={graduated ? 100 : progress} tone={graduated ? 'up' : 'brass'} label="Curve progress" />
        </div>
        <span className="num w-10 text-right text-[12px] text-ink-400">{graduated ? 'pool' : pct(progress)}</span>
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        <ReferenceMeter refs={l.referencesThisBlock} compact freeRefs={l.twoRatchets ? 2 : 1} />
        <Flash value={l.tradeCount} tint={false} className="num text-[11px] text-ink-500">
          {l.tradeCount} trades
        </Flash>
      </div>
    </Link>
  );
}

export function TokenCardSkeleton() {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900 p-3" aria-hidden>
      <div className="flex gap-3">
        <Skeleton className="size-16 shrink-0" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
      <Skeleton className="mt-4 h-1.5 w-full" />
      <Skeleton className="mt-3 h-4 w-24" />
    </div>
  );
}
