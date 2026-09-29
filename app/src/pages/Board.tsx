import {useEffect, useMemo, useState} from 'react';
import {TokenCard, TokenCardSkeleton, TokenImage} from '../components/TokenCard';
import {ReferenceMeter} from '../components/ReferenceMeter';
import {Button} from '../components/ui/Button';
import {Input} from '../components/ui/Field';
import {Badge, Empty, ErrorBox, Progress, Tabs} from '../components/ui/Bits';
import {BRAND} from '../lib/brand';
import {data} from '../lib/data';
import {useLive} from '../lib/live';
import {ago, eth, pct, short} from '../lib/format';
import {Link} from '../lib/router';
import type {Feed, Launch, Sort} from '../lib/types';
import {ADDR} from '../lib/chain';

const PAGE = 12;

export function Board() {
  const [launches, setLaunches] = useState<Launch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [feed, setFeed] = useState<Feed>('all');
  const [sort, setSort] = useState<Sort>('activity');
  const [shown, setShown] = useState(PAGE);

  const load = () => {
    setError(null);
    setLaunches(null);
    data
      .launches()
      .then(setLaunches)
      .catch(e => setError(e instanceof Error ? e.message : 'Could not read the chain'));
  };
  useEffect(load, []);
  // Live: re-read the board in the background; the list swaps in place, no skeleton.
  useLive(async () => setLaunches(await data.launches()), 6000, launches !== null);

  const list = useMemo(() => {
    if (!launches) return [];
    const needle = q.trim().toLowerCase();
    let l = launches.filter(x => (feed === 'all' ? true : feed === 'curve' ? x.phase === 'curve' : x.phase !== 'curve'));
    if (needle) l = l.filter(x => x.name.toLowerCase().includes(needle) || x.symbol.toLowerCase().includes(needle) || x.token.toLowerCase().includes(needle));
    const key: Record<Sort, (x: Launch) => number> = {
      activity: x => x.tradeCount,
      created: x => x.createdAt,
      marketCap: x => x.marketCapEth,
      progress: x => (x.graduationThreshold ? x.quoteReserve / x.graduationThreshold : 0),
      square: x => x.squarePaid,
    };
    return [...l].sort((a, b) => key[sort](b) - key[sort](a));
  }, [launches, q, feed, sort]);

  const king = launches ? [...launches].filter(x => x.phase === 'curve').sort((a, b) => b.quoteReserve - a.quoteReserve)[0] ?? null : null;
  // the newest launch made through Pools, which is where launches go now
  const fresh = launches ? [...launches].filter(x => x.kind === 'pools').sort((a, b) => b.createdAt - a.createdAt)[0] ?? null : null;
  const flagship = launches && ADDR.flagship ? launches.find(x => x.token.toLowerCase() === ADDR.flagship!.toLowerCase()) ?? null : null;
  // The pad's own token is pinned first. If it is also the closest to graduating, one card wears both badges.
  const features: Array<{l: Launch; badges: string[]}> = [];
  if (flagship) features.push({l: flagship, badges: [`flagship · $${BRAND.token}`]});
  if (fresh) features.push({l: fresh, badges: ['live on pools.xyz']});
  if (king && features.length < 2) {
    const same = features.find(f => f.l.token === king.token);
    if (same) same.badges.push('closest to graduating');
    else features.push({l: king, badges: ['closest to graduating']});
  }
  const counts = launches ? {all: launches.length, curve: launches.filter(x => x.phase === 'curve').length, graduated: launches.filter(x => x.phase !== 'curve').length} : undefined;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <section className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-100 sm:text-3xl">{BRAND.tagline}</h1>
          <p className="measure mt-2 text-sm leading-6 text-ink-300">
            {BRAND.thesis.join(' ')}
          </p>
          <p className="measure mt-2 text-[13px] leading-5 text-ink-500">
            This is v0 of{' '}
            <a href={BRAND.standards.eip.url} target="_blank" rel="noreferrer" className="text-brass-400 underline-offset-4 hover:underline">
              {BRAND.standards.eip.label}
            </a>
            , at the token level. {BRAND.secondaries}
          </p>
        </div>
        <Link to="/launch" className="shrink-0">
          <Button size="lg" disabled={!data.deployed}>
            Launch a token
          </Button>
        </Link>
      </section>

      {features.length > 0 && (
        <section aria-label="Featured launches" className={`anim-rise mt-8 grid gap-4 ${features.length > 1 ? 'lg:grid-cols-2' : ''}`}>
          {features.map(f => (
            <Feature key={f.l.token} l={f.l} badges={f.badges} wide={features.length === 1} />
          ))}
        </section>
      )}

      <section className="mt-8 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="md:w-72">
          <Input placeholder="Search name, ticker or address" value={q} onChange={e => setQ(e.target.value)} aria-label="Search launches" />
        </div>
        <Tabs
          value={feed}
          onChange={setFeed}
          options={[
            {value: 'all', label: 'All', count: counts?.all},
            {value: 'curve', label: 'On the curve', count: counts?.curve},
            {value: 'graduated', label: 'In a pool', count: counts?.graduated},
          ]}
        />
        <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-400">
          Sort
          <select
            value={sort}
            onChange={e => setSort(e.target.value as Sort)}
            className="h-9 rounded-md border border-ink-700 bg-ink-900 px-2 text-sm text-ink-100 hover:border-ink-600 focus:border-brass-500 focus:outline-none">
            <option value="activity">activity</option>
            <option value="created">newest</option>
            <option value="marketCap">market cap</option>
            <option value="progress">closest to graduating</option>
            <option value="square">square paid</option>
          </select>
        </label>
      </section>

      <section className="mt-4" aria-live="polite" aria-busy={launches === null}>
        {!data.deployed ? (
          <Empty
            title={`${BRAND.name} is not on ${BRAND.chainName} yet`}
            body="The factory has not been deployed. This page reads the chain and nothing else, so there is nothing to show until it is."
          />
        ) : error ? (
          <ErrorBox title="Could not read the chain" body={error} retry={load} />
        ) : launches === null ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({length: 8}, (_, i) => (
              <TokenCardSkeleton key={i} />
            ))}
          </div>
        ) : list.length === 0 ? (
          <Empty
            title={q ? `Nothing matches "${q}"` : 'No launches yet'}
            body={q ? 'Try the ticker or paste the token address.' : 'Be the first launch on the board.'}
            action={
              q ? (
                <Button variant="secondary" onClick={() => setQ('')}>
                  Clear search
                </Button>
              ) : (
                <Link to="/launch">
                  <Button>Launch a token</Button>
                </Link>
              )
            }
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {list.slice(0, shown).map((l, i) => (
                <TokenCard key={l.token} l={l} index={i} />
              ))}
            </div>
            {list.length > shown && (
              <div className="mt-6 flex justify-center">
                <Button variant="secondary" onClick={() => setShown(s => s + PAGE)}>
                  Show {Math.min(PAGE, list.length - shown)} more
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function Feature({l, badges, wide}: {l: Launch; badges: string[]; wide: boolean}) {
  const progress = l.graduationThreshold ? (l.quoteReserve / l.graduationThreshold) * 100 : 0;
  return (
    <div className={`grid gap-4 rounded-xl border border-brass-700/40 bg-ink-900 p-4 md:p-5 ${wide ? 'md:grid-cols-[1.4fr_1fr]' : ''}`}>
      <Link to={`/t/${l.token}`} className="group flex gap-4">
        <TokenImage l={l} className="size-24 shrink-0 text-base sm:size-32" />
        <div className="min-w-0">
          <div className="flex flex-wrap gap-1.5">
            {badges.map(b => (
              <Badge key={b} tone="brass">
                {b}
              </Badge>
            ))}
          </div>
          <h2 className="mt-2 truncate text-xl font-semibold text-ink-100 group-hover:text-brass-300 sm:text-2xl">
            {l.name} <span className="num text-base font-normal text-ink-500">${l.symbol}</span>
          </h2>
          <p className="measure line-clamp-3 text-sm text-ink-400">{l.description}</p>
          <dl className="num mt-3 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-3">
            <div>
              <dt className="text-ink-500">market cap</dt>
              <dd className="text-ink-100">{eth(l.marketCapEth)}</dd>
            </div>
            <div>
              <dt className="text-ink-500">{l.kind === 'pools' ? 'venue' : 'raised'}</dt>
              <dd className="text-ink-100">
                {l.kind === 'pools' ? 'Uniswap v4 pool' : `${l.quoteReserve.toFixed(3)} / ${l.graduationThreshold} ETH`}
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">square paid</dt>
              <dd className="text-brass-300">
                {l.squarePaid.toFixed(0)} {l.symbol}
              </dd>
            </div>
          </dl>
        </div>
      </Link>
      <div className="flex flex-col justify-between gap-3">
        <div>
          <div className="flex items-baseline justify-between text-[13px]">
            <span className="text-ink-400">{l.kind === 'pools' ? 'In the pool from block one' : l.phase === 'curve' ? 'Curve progress' : 'Graduated'}</span>
            <span className="num text-ink-100">{l.kind === 'pools' ? 'no curve' : pct(Math.min(100, progress))}</span>
          </div>
          <div className="mt-1.5">
            <Progress value={l.kind === 'pools' ? 100 : Math.min(100, progress)} tone={l.kind === 'pools' ? 'up' : 'brass'} label="Curve progress" />
          </div>
          <p className="num mt-1.5 text-[12px] text-ink-500">
            by {short(l.creator)} · {ago(l.createdAt)} ago · {l.tradeCount} trades
          </p>
        </div>
        <ReferenceMeter refs={l.referencesThisBlock} freeRefs={l.twoRatchets ? 2 : 1} />
      </div>
    </div>
  );
}
