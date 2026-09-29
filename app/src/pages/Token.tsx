import {useCallback, useEffect, useRef, useState} from 'react';
import type {Address} from 'viem';
import {CurveChart} from '../components/CurveChart';
import {TokenImage} from '../components/TokenCard';
import {TradePanel} from '../components/TradePanel';
import {Button} from '../components/ui/Button';
import {Badge, Empty, ErrorBox, Progress, Skeleton, toast} from '../components/ui/Bits';
import {BRAND} from '../lib/brand';
import {robinhood} from '../lib/chain';
import {data} from '../lib/data';
import {useLive} from '../lib/live';
import {ago, eth, num, pct, short} from '../lib/format';
import {Link} from '../lib/router';
import type {Launch, Reference, Trade} from '../lib/types';

export function Token({address}: {address: string}) {
  const [l, setL] = useState<Launch | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [refs, setRefs] = useState<Reference[] | null>(null);
  const [tab, setTab] = useState<'trades' | 'references'>('trades');
  const [sheet, setSheet] = useState(false);
  const [head, setHead] = useState<bigint | null>(null);
  /** last block whose logs are in `trades`/`refs`; the live loop reads from here forward */
  const seen = useRef<bigint | null>(null);
  const live = useRef<Launch | null>(null);
  live.current = l ?? null;

  const load = useCallback(() => {
    setErr(null);
    setL(undefined);
    setTrades(null);
    setRefs(null);
    seen.current = null;
    let cancelled = false;
    (async () => {
      try {
        const x = await data.launch(address as Address);
        if (cancelled) return;
        setL(x);
        if (!x) return;
        const to = await data.head();
        const [t, r] = await Promise.all([
          data.trades(x.curve, {from: to > 400_000n ? to - 400_000n : x.createdBlock, to}).catch(() => [] as Trade[]),
          data.references(x.token, {from: to > 400_000n ? to - 400_000n : x.createdBlock, to}).catch(() => [] as Reference[]),
        ]);
        if (cancelled) return;
        setTrades(t);
        setRefs(r);
        seen.current = to;
        setHead(to);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Could not read the chain');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);
  useEffect(load, [load]);

  // Live: every tick, read the head; pull the new blocks' logs and re-read the launch's numbers.
  const tick = useCallback(async () => {
    const cur = live.current;
    const from = seen.current;
    if (!cur || from === null) return;
    const to = await data.head();
    if (to <= from) return;
    const range = {from: from + 1n, to};
    const [t, r, fresh] = await Promise.all([
      data.trades(cur.curve, range),
      data.references(cur.token, range),
      data.refresh(cur),
    ]);
    seen.current = to;
    setHead(to);
    if (t.length) setTrades(prev => [...(prev ?? []), ...t]);
    if (r.length) setRefs(prev => [...(prev ?? []), ...r]);
    setL({...fresh, tradeCount: cur.tradeCount + t.length});
  }, []);
  useLive(tick, 2000, !!l);

  if (!data.deployed) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <Empty title={`${BRAND.name} is not on ${BRAND.chainName} yet`} body="No factory, no tokens. This page reads the chain and nothing else." />
      </main>
    );
  }
  if (err) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <ErrorBox title="Could not read the chain" body={err} retry={load} />
      </main>
    );
  }
  if (l === null) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <ErrorBox title="No launch at that address" body={`${address} is not a token launched on ${BRAND.name}.`} />
        <Link to="/" className="mt-4 inline-block">
          <Button variant="secondary">Back to the board</Button>
        </Link>
      </main>
    );
  }

  const progress = l ? Math.min(100, l.graduationThreshold ? (l.quoteReserve / l.graduationThreshold) * 100 : 0) : 0;
  const graduated = l?.phase !== 'curve';
  const explorer = robinhood.blockExplorers.default.url;

  return (
    <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <p role="note" className="mb-4 border-l-2 border-brass-500 pl-3 text-[13px] leading-5 text-ink-300">
        {l?.kind === 'pools'
          ? 'This token lives in one plain Uniswap v4 pool. Buy here or through any aggregator: the quote comes from the same pool. Your first two transfers in a block are free.'
          : BRAND.secondaries}{' '}
        <Link to="/how" className="text-brass-400 underline-offset-4 hover:underline">
          Why
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link to="/" className="text-[13px] text-ink-500 hover:text-ink-200">
          ← Board
        </Link>
        {l ? (
          <>
            <TokenImage l={l} className="size-8 text-[10px]" />
            <h1 className="text-lg font-semibold text-ink-100">
              {l.name} <span className="num text-sm font-normal text-ink-500">${l.symbol}</span>
            </h1>
            {l.kind === 'pools' ? <Badge tone="brass">pools.xyz</Badge> : graduated ? <Badge tone="brass">graduated</Badge> : <Badge>on the curve</Badge>}
            {head !== null && (
              <span className="num inline-flex items-center gap-1.5 text-[11px] text-ink-500" title="Updates every block, no refresh needed">
                <span className="relative flex size-1.5">
                  <span className="anim-pulse absolute inline-flex size-full rounded-full bg-up-500 opacity-60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-up-400" />
                </span>
                live · #{head.toString()}
              </span>
            )}
            <dl className="num ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <Stat k="mc" v={eth(l.marketCapEth)} />
              {l.kind !== 'pools' && <Stat k="raised" v={`${l.quoteReserve.toFixed(3)} ETH`} />}
              <Stat k="square paid" v={`${num(l.squarePaid)} ${l.symbol}`} tone="brass" />
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(l.token);
                  toast('Address copied');
                }}
                className="rounded border border-ink-800 px-2 py-0.5 text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200 focus-visible:outline-brass-400"
                title={l.token}>
                {short(l.token)} ⧉
              </button>
              <a href={`${explorer}/address/${l.token}`} target="_blank" rel="noreferrer" className="text-ink-500 hover:text-ink-200">
                explorer ↗
              </a>
              <button
                onClick={() => {
                  const link = `${window.location.origin}/t/${l.token}`;
                  if (navigator.share) navigator.share({title: `${l.name} on ${BRAND.name}`, url: link}).catch(() => {});
                  else {
                    navigator.clipboard?.writeText(link);
                    toast('Link copied');
                  }
                }}
                className="rounded border border-ink-800 px-2 py-0.5 text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200 focus-visible:outline-brass-400">
                share
              </button>
              <a
                href={`https://x.com/intent/post?text=${encodeURIComponent(`${l.name} ($${l.symbol}) on ${BRAND.name}`)}&url=${encodeURIComponent(`https://squarefun.xyz/t/${l.token}`)}`}
                target="_blank"
                rel="noreferrer"
                className="text-ink-500 hover:text-ink-200">
                post ↗
              </a>
            </dl>
          </>
        ) : (
          <>
            <Skeleton className="size-8" />
            <Skeleton className="h-5 w-40" />
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          {trades ? <CurveChart trades={trades} symbol={l?.symbol ?? ''} /> : <Skeleton className="h-72 w-full" />}

          {l && (
            <section className="rounded-lg border border-ink-800 bg-ink-900 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[13px] font-medium text-ink-300">{l.kind === 'pools' ? 'Launched on pools.xyz' : graduated ? 'Graduated' : 'Curve progress'}</p>
                <p className="num text-[13px] text-ink-400">
                  {l.kind === 'pools' ? (
                    <a href={`https://pools.xyz/t/robinhood/${l.token}`} target="_blank" rel="noreferrer" className="text-brass-400 hover:underline">
                      open on pools.xyz ↗
                    </a>
                  ) : (
                    `${l.quoteReserve.toFixed(3)} / ${l.graduationThreshold} ${BRAND.quote} · ${pct(graduated ? 100 : progress)}`
                  )}
                </p>
              </div>
              <div className="mt-2">
                <Progress value={graduated ? 100 : progress} tone={graduated ? 'up' : 'brass'} label="Curve progress" />
              </div>
              <p className="measure mt-2 text-[13px] text-ink-500">
                {l.kind === 'pools'
                  ? 'No curve. The whole supply went into a native-ETH Uniswap v4 pool in the launch transaction, and the position is locked in Uniswap\'s fee splitter for good. Every transfer after the launch block is a reference.'
                  : graduated
                  ? 'The curve closed and its whole reserve seeded a full-range Uniswap v4 position that nothing can remove. From here every transfer is a reference.'
                  : `When ${l.graduationThreshold} ${BRAND.quote} is raised the curve sweeps into a permanent full-range pool. Until then, trading with the curve is free of the square.`}
              </p>
              {l.description && <p className="measure mt-3 text-sm text-ink-200">{l.description}</p>}
              <p className="num mt-2 text-[12px] text-ink-500">
                created by{' '}
                <a href={`${explorer}/address/${l.creator}`} target="_blank" rel="noreferrer" className="text-brass-400 hover:underline">
                  {short(l.creator)}
                </a>{' '}
                · {ago(l.createdAt)} ago
                {(['twitter', 'telegram', 'discord', 'website', 'farcaster'] as const)
                  .filter(k => l.socials[k])
                  .map(k => (
                    <span key={k}>
                      {' · '}
                      <a href={l.socials[k]} className="text-ink-300 hover:text-brass-300" target="_blank" rel="noreferrer">
                        {k === 'twitter' ? 'x' : k}
                      </a>
                    </span>
                  ))}
              </p>
            </section>
          )}

          <div className="flex gap-1 border-b border-ink-800">
            {(['trades', 'references'] as const).map(t => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                  tab === t ? 'border-brass-500 text-ink-100' : 'border-transparent text-ink-400 hover:text-ink-200'
                } focus-visible:outline-brass-400`}>
                {t === 'trades' ? 'Curve trades' : 'References paid'}
                <span className="num ml-1.5 text-[11px] text-ink-500">{t === 'trades' ? trades?.length ?? '' : refs?.length ?? ''}</span>
              </button>
            ))}
          </div>
          {tab === 'trades' ? <TradesTable trades={trades} symbol={l?.symbol ?? ''} explorer={explorer} /> : <RefsTable refs={refs} symbol={l?.symbol ?? ''} explorer={explorer} />}
        </div>

        <aside className="hidden lg:block">
          <div className="sticky top-[72px]">{l ? <TradePanel l={l} onTraded={() => void tick()} /> : <Skeleton className="h-96 w-full" />}</div>
        </aside>
      </div>

      {l && (
        <>
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-800 bg-ink-950/95 p-3 backdrop-blur-sm lg:hidden">
            <Button className="w-full" size="lg" onClick={() => setSheet(true)}>
              {graduated ? 'Pool status' : `Trade ${l.symbol}`}
            </Button>
          </div>
          {sheet && (
            <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={`Trade ${l.symbol}`}>
              <button className="anim-fade absolute inset-0 bg-ink-950/70" aria-label="Close" onClick={() => setSheet(false)} />
              <div className="anim-rise absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-xl border-t border-ink-700 bg-ink-950 p-3 pb-6">
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-700" />
                <TradePanel l={l} onTraded={() => { setSheet(false); void tick(); }} />
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function Stat({k, v, tone}: {k: string; v: string; tone?: 'brass'}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-500">{k}</dt>
      <dd className={tone === 'brass' ? 'text-brass-300' : 'text-ink-200'}>{v}</dd>
    </div>
  );
}

function TradesTable({trades, symbol, explorer}: {trades: Trade[] | null; symbol: string; explorer: string}) {
  if (!trades) return <Skeleton className="h-40 w-full" />;
  if (trades.length === 0) return <p className="py-8 text-center text-sm text-ink-500">No curve trades in the last few hours.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-800">
      <table className="num w-full text-[13px]">
        <thead className="bg-ink-900 text-left text-ink-500">
          <tr>
            <th className="px-3 py-2 font-normal">when</th>
            <th className="px-3 py-2 font-normal">side</th>
            <th className="px-3 py-2 text-right font-normal">ETH</th>
            <th className="px-3 py-2 text-right font-normal">{symbol}</th>
            <th className="px-3 py-2 text-right font-normal">fee</th>
            <th className="px-3 py-2 font-normal">who</th>
          </tr>
        </thead>
        <tbody>
          {[...trades].reverse().slice(0, 50).map(t => (
            <tr key={t.tx + t.side + t.tokens} className="border-t border-ink-850 hover:bg-ink-900">
              <td className="px-3 py-1.5 text-ink-500">
                <a href={`${explorer}/tx/${t.tx}`} target="_blank" rel="noreferrer" className="hover:text-ink-200">
                  {ago(t.ts)}
                </a>
              </td>
              <td className={`px-3 py-1.5 ${t.side === 'buy' ? 'text-up-400' : 'text-down-400'}`}>{t.side}</td>
              <td className="px-3 py-1.5 text-right text-ink-200">{t.quote.toFixed(4)}</td>
              <td className="px-3 py-1.5 text-right text-ink-300">{num(t.tokens)}</td>
              <td className="px-3 py-1.5 text-right text-ink-500">{t.fee.toFixed(5)}</td>
              <td className="px-3 py-1.5 text-ink-500">{short(t.who, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RefsTable({refs, symbol, explorer}: {refs: Reference[] | null; symbol: string; explorer: string}) {
  if (!refs) return <Skeleton className="h-40 w-full" />;
  if (refs.length === 0)
    return (
      <p className="measure py-8 text-center text-sm text-ink-500">
        No references paid yet. On the curve nothing is a reference; after graduation every transfer is, and the ones that were not first in their block show up here.
      </p>
    );
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-800">
      <table className="num w-full text-[13px]">
        <thead className="bg-ink-900 text-left text-ink-500">
          <tr>
            <th className="px-3 py-2 font-normal">when</th>
            <th className="px-3 py-2 font-normal">block</th>
            <th className="px-3 py-2 text-right font-normal">ref #</th>
            <th className="px-3 py-2 text-right font-normal">fee ({symbol})</th>
            <th className="px-3 py-2 font-normal">from → to</th>
          </tr>
        </thead>
        <tbody>
          {[...refs].reverse().slice(0, 50).map(r => (
            <tr key={r.tx + r.n} className="border-t border-ink-850 hover:bg-ink-900">
              <td className="px-3 py-1.5 text-ink-500">
                <a href={`${explorer}/tx/${r.tx}`} target="_blank" rel="noreferrer" className="hover:text-ink-200">
                  {ago(r.ts)}
                </a>
              </td>
              <td className="px-3 py-1.5 text-ink-500">{r.block.toString()}</td>
              <td className={`px-3 py-1.5 text-right ${r.n >= 3 ? 'text-down-400' : 'text-warn-500'}`}>#{r.n}</td>
              <td className="px-3 py-1.5 text-right text-ink-200">{r.fee === 0 ? 'free' : num(r.fee, 4)}</td>
              <td className="px-3 py-1.5 text-ink-500">
                {short(r.from, 3)} → {short(r.to, 3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
