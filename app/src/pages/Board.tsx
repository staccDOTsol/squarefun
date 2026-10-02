import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityBeat, ActivityFeed, LeaderTable, LiveHeading} from '../components/Activity';
import {TokenCard, TokenCardSkeleton, TokenImage} from '../components/TokenCard';
import {ReferenceMeter} from '../components/ReferenceMeter';
import {Button} from '../components/ui/Button';
import {Input} from '../components/ui/Field';
import {Badge, Empty, ErrorBox, Progress, Tabs} from '../components/ui/Bits';
import {Flash} from '../components/ui/Live';
import {useActivity} from '../lib/activity';
import {asLaunch, contagian, CONTAGIAN_SUPPLY, ofParity, type ContagianLaunch} from '../lib/contagian';
import {useSquareLeadersAll} from '../lib/leaders';
import {BRAND} from '../lib/brand';
import {data} from '../lib/data';
import {useLive} from '../lib/live';
import {ago, eth, num, pct, price, short} from '../lib/format';
import {Link} from '../lib/router';
import type {Feed, Launch, Sort} from '../lib/types';
import {ADDR} from '../lib/chain';

const PAGE = 12;

export function Board() {
  const [launches, setLaunches] = useState<Launch[] | null>(null);
  const [ctgs, setCtgs] = useState<ContagianLaunch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [feed, setFeed] = useState<Feed>('all');
  const [sort, setSort] = useState<Sort>('activity');
  const [shown, setShown] = useState(PAGE);

  // every launch on the site: the pad's and Pools', and Contagian tokens beside them. A failure reading Contagian must not empty the board.
  const reload = useCallback(async () => {
    const [square, ctg] = await Promise.all([data.launches(), contagian.list().catch(() => [])]);
    setLaunches([...square, ...ctg.map(c => asLaunch(c))]);
    setCtgs(ctg);
  }, []);
  const load = () => {
    setError(null);
    setLaunches(null);
    reload().catch(e => setError(e instanceof Error ? e.message : 'Could not read the chain'));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [rail, setRail] = useState<'activity' | 'leaders'>('activity');

  // Live: re-read the board in the background; the list swaps in place, no skeleton. The shared
  // activity read says when a trade or a fee has landed, and the board is read again the moment
  // one does; without one it is read every few seconds, for launches and phases.
  useLive(reload, 5000, launches !== null);
  const activity = useActivity();
  const newest = activity.events[0]?.id;
  const told = useRef<string | undefined>(undefined);
  useEffect(() => {
    const before = told.current;
    told.current = newest;
    if (before !== undefined && newest !== before) void reload().catch(() => {});
  }, [newest, reload]);

  // fees are paid in each token; the board prices them in ETH so one wallet's fees across tokens add up
  const prices = useMemo(() => Object.fromEntries((launches ?? []).map(l => [l.token.toLowerCase(), l.priceEth])), [launches]);
  const leaders = useSquareLeadersAll(prices);

  const swaps = activity.swaps;
  const list = useMemo(() => {
    if (!launches) return [];
    const needle = q.trim().toLowerCase();
    let l = launches.filter(x => (feed === 'all' ? true : feed === 'curve' ? x.phase === 'curve' : x.phase !== 'curve'));
    if (needle) l = l.filter(x => x.name.toLowerCase().includes(needle) || x.symbol.toLowerCase().includes(needle) || x.token.toLowerCase().includes(needle));
    const key: Record<Sort, (x: Launch) => number> = {
      // a Contagian token's trades are the swaps in its pool, counted by the activity read
      activity: x => (x.kind === 'contagian' ? swaps[x.token.toLowerCase()] ?? 0 : x.tradeCount),
      created: x => x.createdAt,
      marketCap: x => x.marketCapEth,
      progress: x => (x.graduationThreshold ? x.quoteReserve / x.graduationThreshold : 0),
      square: x => x.squarePaid,
    };
    return [...l].sort((a, b) => key[sort](b) - key[sort](a));
  }, [launches, q, feed, sort, swaps]);

  // Contagian launches lead the page, the busiest first
  const contagians = useMemo(
    () => [...ctgs].sort((a, b) => (swaps[b.token.toLowerCase()] ?? 0) - (swaps[a.token.toLowerCase()] ?? 0) || b.launchedAt - a.launchedAt).slice(0, 4),
    [ctgs, swaps],
  );

  const king = launches ? [...launches].filter(x => x.phase === 'curve').sort((a, b) => b.quoteReserve - a.quoteReserve)[0] ?? null : null;
  // the newest launch made through Pools, which is where launches go now
  const fresh = launches ? [...launches].filter(x => x.kind === 'pools').sort((a, b) => b.createdAt - a.createdAt)[0] ?? null : null;
  const flagship = launches && ADDR.flagship ? launches.find(x => x.token.toLowerCase() === ADDR.flagship!.toLowerCase()) ?? null : null;
  // The pad's own token is pinned first. If it is also the closest to graduating, one card wears both badges.
  const hero = launches && ADDR.hero ? launches.find(x => x.token.toLowerCase() === ADDR.hero!.token.toLowerCase()) ?? null : null;
  const features: Array<{l: Launch; badges: string[]}> = [];
  // the hero goes first, then the pad's own token; a launch already featured is not repeated
  const feature = (l: Launch | null, badge: string) => {
    if (!l) return;
    const same = features.find(f => f.l.token === l.token);
    if (same) same.badges.push(badge);
    else features.push({l, badges: [badge]});
  };
  feature(hero, ADDR.hero?.badge ?? 'featured');
  feature(flagship, `flagship · $${BRAND.token}`);
  if (features.length < 2) feature(fresh, 'live on pools.xyz');
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

      {contagians.length > 0 && (
        <section aria-label="Contagian launches" className={`anim-rise mt-8 grid gap-4 ${contagians.length > 1 ? 'lg:grid-cols-2' : ''}`}>
          {contagians.map(c => (
            <ContagianFeature key={c.token} c={c} trades={swaps[c.token.toLowerCase()] ?? 0} wide={contagians.length === 1} />
          ))}
        </section>
      )}

      {features.length > 0 && (
        <section aria-label="Featured launches" className={`anim-rise ${contagians.length > 0 ? 'mt-4' : 'mt-8'} grid gap-4 ${features.length > 1 ? 'lg:grid-cols-2' : ''}`}>
          {features.map(f => (
            <Feature key={f.l.token} l={f.l} badges={f.badges} wide={features.length === 1} />
          ))}
        </section>
      )}

      {/* A monitor, not a wall of cards: launches on the left, what just happened beside them. Under xl the rail sits above the list, one tab at a time. */}
      <div className="mt-8 xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start xl:gap-6">
        <aside className="mb-8 xl:sticky xl:top-[72px] xl:col-start-2 xl:row-start-1 xl:mb-0 xl:max-h-[calc(100dvh-88px)] xl:overflow-y-auto" aria-label="Live">
          <div className="mb-2 flex items-center justify-between xl:hidden">
            <Tabs
              size="sm"
              value={rail}
              onChange={setRail}
              options={[
                {value: 'activity', label: 'Activity'},
                {value: 'leaders', label: 'Leaderboard'},
              ]}
            />
            <ActivityBeat beat={activity.beat} />
          </div>
          <section aria-labelledby="board-activity-h" className={`${rail === 'activity' ? '' : 'hidden'} xl:block`}>
            <div className="hidden xl:block">
              <LiveHeading id="board-activity-h" right={<ActivityBeat beat={activity.beat} />}>
                Activity
              </LiveHeading>
            </div>
            <div className="xl:mt-2">
              <ActivityFeed {...activity} rows={10} empty="Nothing yet. Trades and fees on every launch show up here as they land." />
            </div>
          </section>
          <section aria-labelledby="board-leaders-h" className={`${rail === 'leaders' ? '' : 'hidden'} xl:mt-5 xl:block`}>
            <div className="hidden xl:block">
              <LiveHeading id="board-leaders-h">Most paid to the square</LiveHeading>
            </div>
            <div className="xl:mt-2">
              <LeaderTable
                {...leaders}
                unit="ETH"
                show={8}
                empty="Nobody has paid a reference fee yet. The first wallet to make a third transfer in a block leads this."
              />
            </div>
            <p className="mt-1.5 text-[12px] leading-5 text-ink-500">Reference fees paid on every launch, each valued in ETH at its token's price now.</p>
          </section>
        </aside>

        <div className="min-w-0 xl:col-start-1 xl:row-start-1">
      <section className="flex flex-col gap-3 md:flex-row md:items-center">
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.slice(0, shown).map((l, i) => (
                <TokenCard key={l.token} l={l.kind === 'contagian' ? {...l, tradeCount: swaps[l.token.toLowerCase()] ?? 0} : l} index={i} />
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
        </div>
      </div>
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
              <dd className="text-ink-100">
                <Flash value={l.marketCapEth}>{eth(l.marketCapEth)}</Flash>
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">{l.kind === 'pools' ? 'venue' : 'raised'}</dt>
              <dd className="text-ink-100">
                {l.kind === 'pools' ? 'Uniswap v4 pool' : `${l.quoteReserve.toFixed(3)} / ${l.graduationThreshold} ETH`}
              </dd>
            </div>
            {l.moonJarEth !== undefined ? (
              <div>
                <dt className="text-ink-500">moon jar</dt>
                <dd className="text-brass-300">
                  <Flash value={l.moonJarEth} tint={false}>
                    {eth(l.moonJarEth)}
                  </Flash>
                </dd>
              </div>
            ) : (
              <div>
                <dt className="text-ink-500">square paid</dt>
                <dd className="text-brass-300">
                  <Flash value={l.squarePaid} tint={false}>
                    {l.squarePaid.toFixed(0)} {l.symbol}
                  </Flash>
                </dd>
              </div>
            )}
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
            by {short(l.creator)} · {ago(l.createdAt)} ago ·{' '}
            <Flash value={l.tradeCount} tint={false}>
              {l.tradeCount} trades
            </Flash>
          </p>
        </div>
        <ReferenceMeter refs={l.referencesThisBlock} freeRefs={l.twoRatchets ? 2 : 1} />
      </div>
    </div>
  );
}

/** A Contagian launch at the top of the board: where it stands against parity, and who pays on that side. */
function ContagianFeature({c, trades, wide}: {c: ContagianLaunch; trades: number; wide: boolean}) {
  const parityPct = c.spot !== null && c.parity !== null && c.parity > 0 ? (c.spot / c.parity) * 100 : null;
  const over = parityPct !== null && parityPct > 100;
  const rule = parityPct === null ? `Tends to 1 ${c.peg.symbol}.` : over ? 'Over parity: buyers pay, sellers don\'t.' : parityPct < 100 ? 'Under parity: sellers pay, buyers don\'t.' : 'At parity: move it either way and you pay for the move.';
  const bp = (b: number | null) => (b === null ? '—' : `${(b / 100).toFixed(2)}%`);
  return (
    <div className={`grid gap-4 rounded-xl border border-brass-700/40 bg-ink-900 p-4 md:p-5 ${wide ? 'md:grid-cols-[1.4fr_1fr]' : ''}`}>
      <Link to={`/t/${c.token}`} className="group flex gap-4">
        <TokenImage l={c} className="size-24 shrink-0 text-base sm:size-32" />
        <div className="min-w-0">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="brass">Contagian</Badge>
            <Badge>
              tends to 1 {c.peg.symbol}
            </Badge>
          </div>
          <h2 className="mt-2 truncate text-xl font-semibold text-ink-100 group-hover:text-brass-300 sm:text-2xl">
            {c.name} <span className="num text-base font-normal text-ink-500">${c.symbol}</span>
          </h2>
          <p className="measure line-clamp-2 text-sm text-ink-400">{c.description}</p>
          <dl className="num mt-3 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
            <div>
              <dt className="text-ink-500">price</dt>
              <dd className="text-ink-100">
                <Flash value={c.spot}>
                  {c.spot === null ? '—' : price(c.spot)} {c.quote.symbol}
                </Flash>
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">market cap</dt>
              <dd className="text-ink-100">
                <Flash value={c.spot}>
                  {c.spot === null ? '—' : num(c.spot * CONTAGIAN_SUPPLY, 0)} {c.quote.symbol}
                </Flash>
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">tax buy / sell</dt>
              <dd className="text-ink-100">
                <Flash value={c.buyBps === null || c.sellBps === null ? null : c.buyBps * 100_000 + c.sellBps} tint={false}>
                  {bp(c.buyBps)} / {bp(c.sellBps)}
                </Flash>
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">tolls held</dt>
              <dd className="text-brass-300">
                <Flash value={c.tolls} tint={false}>
                  {c.tolls === null ? '—' : num(c.tolls, 0)}
                </Flash>
              </dd>
            </div>
          </dl>
        </div>
      </Link>
      <div className="flex flex-col justify-between gap-3">
        <div>
          <div className="flex items-baseline justify-between text-[13px]">
            <span className="text-ink-400">Of parity</span>
            <Flash value={parityPct} className="num text-ink-100">
              {parityPct === null ? '—' : ofParity(parityPct)}
            </Flash>
          </div>
          <div className="mt-1.5">
            <Progress value={Math.min(100, parityPct ?? 0)} tone={over ? 'up' : 'brass'} label="Share of parity" />
          </div>
          <p className="mt-2 text-[13px] leading-5 text-ink-300">{rule} Faster costs more. Holding is free.</p>
          <p className="num mt-1.5 text-[12px] text-ink-500">
            by {short(c.creator)} · {ago(c.launchedAt)} ago ·{' '}
            <Flash value={trades} tint={false}>
              {trades} trades
            </Flash>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/t/${c.token}`}>
            <Button>Trade ${c.symbol}</Button>
          </Link>
          <Link to="/contagian">
            <Button variant="secondary">How Contagian works</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
