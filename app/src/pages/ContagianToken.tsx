import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {Address} from 'viem';
import {ActivityBeat, ActivityFeed, LeaderTable, LiveHeading, amt, type LeaderRow} from '../components/Activity';
import {ContagianPayoff} from '../components/ContagianPayoff';
import {ContagianTrade} from '../components/ContagianTrade';
import {CurveChart} from '../components/CurveChart';
import {TokenImage} from '../components/TokenCard';
import {TradesTable} from '../components/TradesTable';
import {Button} from '../components/ui/Button';
import {Badge, Empty, ErrorBox, Skeleton, toast} from '../components/ui/Bits';
import {Flash, Heartbeat, useNow} from '../components/ui/Live';
import {useActivity} from '../lib/activity';
import {BRAND} from '../lib/brand';
import {contagian, contagianDeployed, contagianTx, ofParity, span, tickPrice, toAddress, type ContagianDetail, type ContagianWallet} from '../lib/contagian';
import {ago, num, price, short} from '../lib/format';
import {useContagianLeaders} from '../lib/leaders';
import {useLive} from '../lib/live';
import {Link} from '../lib/router';
import type {Trade} from '../lib/types';
import {useWallet} from '../lib/wallet';

/** Where a price stands against parity, and so who pays: the rule in one line. */
export function side(spot: number | null, parity: number | null): {pct: number | null; line: string; tone: string} {
  if (spot === null || parity === null || !(parity > 0)) return {pct: null, line: '', tone: 'text-ink-500'};
  const pct = (spot / parity) * 100;
  if (spot < parity) return {pct, line: 'Under parity: sellers pay, buyers don’t', tone: 'text-down-400'};
  if (spot > parity) return {pct, line: 'Over parity: buyers pay, sellers don’t', tone: 'text-up-400'};
  return {pct, line: 'At parity: move it either way and you pay for the move', tone: 'text-brass-300'};
}
export const bp = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(2)}%`);
export const shown = (v: number | null, f: (n: number) => string) => (v === null ? '—' : f(v));

/** Reads again every `ms`, whatever else happens: a counter to hang a slow re-read on. */
export function useSlow(ms: number, enabled: boolean) {
  const [n, setN] = useState(0);
  useLive(() => setN(x => x + 1), ms, enabled);
  return n;
}

const TICK = 2000;

/**
 * A balance that grows between reads. The vault does not publish its release rate, so the rate is
 * the one seen between the last two reads, carried forward for a few seconds at most: the next
 * read corrects it.
 */
function Streaming({value, perSecond, readAt, unit}: {value: number; perSecond: number; readAt: number; unit: string}) {
  const running = perSecond > 0;
  const now = useNow(250, running);
  const shownNow = value + (running ? Math.min(TICK * 3, Math.max(0, now - readAt)) / 1000 : 0) * perSecond;
  // enough places that a second's worth shows
  const digits = running ? Math.min(10, Math.max(2, Math.ceil(-Math.log10(perSecond)) + 1)) : 4;
  return (
    <Flash value={value}>
      {shownNow.toFixed(digits)} {unit}
    </Flash>
  );
}

/** Time left until `at`, counting down each second. */
function Countdown({at}: {at: number}) {
  const now = useNow(1000);
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return <>{h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`}</>;
}

/** A header figure. `n` is what is watched: when it moves the figure rolls and holds a tint (`plain`: no green or red). */
function Stat({k, v, n, tone, plain}: {k: string; v: string; n: number | null; tone?: string; plain?: boolean}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-500">{k}</dt>
      <dd className={tone ?? 'text-ink-200'}>
        <Flash value={n} tint={!plain}>
          {v}
        </Flash>
      </dd>
    </div>
  );
}

/**
 * A Contagian token's page: the same shape as any token's (chart, trades, live price, the trade
 * panel) with what is its own beside it: where the price stands against parity and so who pays,
 * the wallet's place in the directory, the feed, the bad beats, and the vault's note.
 *
 * `/t/<token>` renders this when the launcher made the token; `/contagian/<token>` is the same page.
 */
export function ContagianToken({address}: {address: string}) {
  const wallet = useWallet();
  const token = toAddress(address);
  const [l, setL] = useState<ContagianDetail | null | undefined>(undefined);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [head, setHead] = useState<bigint | null>(null);
  const [mine, setMine] = useState<ContagianWallet | null>(null);
  /** what each claimable grew by per second between the last two reads */
  const [rates, setRates] = useState({payer: 0, holder: 0});
  const last = useRef<ContagianWallet | null>(null);
  /** last block whose swaps are in `trades`; each read asks only for the blocks since */
  const seen = useRef<bigint | null>(null);
  const reading = useRef<Promise<void> | null>(null);
  const [standings, setStandings] = useState<Awaited<ReturnType<typeof contagian.standings>>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  /** goes up on every read that came back: the heartbeat's bar starts again */
  const [beat, setBeat] = useState(0);
  const now = useNow(1000, !!mine && mine.waiting > 0);

  // this token's slice of the site's one activity read, and its vault's directory ranked from the same logs
  const activity = useActivity({token: token ?? undefined, family: 'contagian'});
  const tax = useContagianLeaders(token ?? '0x');
  const board = tax.boards[0];

  // One read at a time: the vault's numbers, the wallet's entry, and the pool's swaps since the last read.
  const read = useCallback(() => {
    if (reading.current) return reading.current;
    const run = async () => {
      if (!token) return setL(null);
      const [d, to] = await Promise.all([contagian.one(token), contagian.head()]);
      setL(d);
      if (!d) return;
      const first = seen.current === null;
      const from = first ? contagian.chartFrom(to) : seen.current! + 1n;
      const [fresh, m] = await Promise.all([
        // a failed read of the swaps keeps the chart as it is; the same blocks are asked for again next time
        contagian.trades(d, {from, to}).catch(() => null),
        wallet.address ? contagian.wallet(d, wallet.address).catch(() => null) : null,
      ]);
      if (fresh) {
        seen.current = to;
        setHead(to);
        if (first) setTrades(fresh);
        else if (fresh.length) setTrades(prev => [...(prev ?? []), ...fresh]);
      } else if (first) setTrades(prev => prev ?? []);
      const before = last.current;
      last.current = m;
      const dt = m && before ? (m.readAt - before.readAt) / 1000 : 0;
      // a balance that fell was claimed or moved: no rate until the next read
      setRates(m && before && dt > 0 ? {payer: Math.max(0, (m.asPayer - before.asPayer) / dt), holder: Math.max(0, (m.asHolder - before.asHolder) / dt)} : {payer: 0, holder: 0});
      setMine(m);
      setBeat(b => b + 1);
    };
    reading.current = run().finally(() => {
      reading.current = null;
    });
    return reading.current;
  }, [token, wallet.address]);
  const load = useCallback(() => {
    setErr(null);
    read().catch(e => setErr(e instanceof Error ? e.message : 'Could not read the vault'));
  }, [read]);
  useEffect(load, [load]);
  useLive(read, TICK, !!l);

  // what the directory holds for the wallets on the board: read when the board or the feed changes, and every ten seconds
  const top = (board?.rows ?? []).slice(0, 8).map(r => r.who);
  const slow = useSlow(10_000, top.length > 0);
  const vault = l?.vault;
  const sig = `${vault}:${top.join()}:${activity.events[0]?.id}:${slow}`;
  useEffect(() => {
    if (!l || top.length === 0) return;
    let on = true;
    contagian
      .standings(l, top)
      .then(x => on && setStandings(x))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  // the pool names the router; the activity read knows the wallet each swap was for
  const wallets = useMemo(() => {
    const m = new Map<string, Address>();
    for (const e of activity.events) if (e.kind === 'buy' || e.kind === 'sell') m.set(e.txHash, e.who);
    return m;
  }, [activity.events]);

  const run = async (what: string, fn: () => Promise<unknown>, ok: string) => {
    if (wallet.status === 'wrong-chain') return wallet.switchChain();
    if (wallet.status !== 'connected' || !wallet.client || !wallet.address) return wallet.connect();
    setBusy(what);
    try {
      await fn();
      toast(ok);
      load();
    } catch (e) {
      toast((e instanceof Error ? e.message : 'Transaction failed').split('\n')[0].slice(0, 120), 'err');
    } finally {
      setBusy(null);
    }
  };
  const w = wallet.client!;
  const me = wallet.address!;

  if (err && !l) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <ErrorBox title="Could not read the vault" body={err} retry={load} />
      </main>
    );
  }
  if (l === null) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <Empty
          title="Not a Contagian token"
          body={contagianDeployed ? 'The Contagian launcher did not make this token.' : 'The Contagian launcher is not deployed yet.'}
          action={
            <Link to="/contagian" className="text-sm text-brass-400 underline-offset-4 hover:underline">
              All Contagian tokens
            </Link>
          }
        />
      </main>
    );
  }

  const q = l?.quote.symbol ?? '';
  const hour = span(l?.drip ?? 3600);
  const connected = wallet.status === 'connected';
  const label = wallet.status === 'wrong-chain' ? `Switch to ${BRAND.chainName}` : connected ? null : 'Connect';
  const matured = !!mine && mine.waiting > 0 && now >= mine.maturesAt;
  const where = side(l?.spot ?? null, l?.parity ?? null);
  const underParity = !!l && l.spot !== null && l.parity !== null && l.spot < l.parity;
  const overParity = !!l && l.spot !== null && l.parity !== null && l.spot > l.parity;
  const gotchya = activity.events.find(e => e.kind === 'gotchya');
  const rows: LeaderRow[] = (board?.rows ?? []).map(r => {
    const st = standings[r.who.toLowerCase()];
    const text = st ? `earning ${amt(st.earning)} · ${(st.shareBps / 100).toFixed(1)}% · claimable ${amt(st.claimable)}` : undefined;
    return {...r, note: text ? <span title={text}>{text}</span> : undefined};
  });
  const cranks: Array<{id: string; name: string; does: string; fn: () => Promise<unknown>; ok: string; blocked?: string}> = l
    ? [
        {
          id: 'offer',
          name: 'Offer',
          does: 'Puts a tranche of tolls on sale above the price in the launch pool. Buyers on the way up take it; nothing is pushed down. At most once an hour.',
          fn: () => contagianTx.offer(w, me, l.vault),
          ok: 'Offered',
        },
        {
          id: 'settle',
          name: 'Settle',
          does: 'While the price is over parity: sells tolls into the launch pool, down to parity (or to the price’s average, if that is higher) and no further. What it brings in is split between the bad beats and holders, less a 0.5% tip for whoever calls.',
          fn: () => contagianTx.settle(w, me, l.vault),
          ok: 'Settled',
          blocked: overParity ? undefined : 'The price is not over parity, so there is nothing to sell: tolls are never sold downward.',
        },
        ...(l.partnerCount > 0
          ? [
              {
                id: 'deepen',
                name: 'Deepen',
                does: 'Offers a tranche of tolls against the partner asset, over the token’s price in it, in the partner’s pool with the token: the token alone, so none of the partner is at risk. At most once an hour, and the first call only takes a reading.',
                fn: () => contagianTx.deepen(w, me, l.vault),
                ok: 'Deepened',
              },
            ]
          : []),
        {
          id: 'harvest',
          name: 'Harvest',
          does: `Collects from the vault’s ${l.rangeCount} range${l.rangeCount === 1 ? '' : 's'}: what an offer that has sold through sold for (split between the bad beats and holders), and what the others have earned in fees (a quarter to the Stacc Wizards, a quarter to ${BRAND.token} stakers, half to the bad beats). The token side joins the tolls.`,
          fn: () => contagianTx.harvest(w, me, l.vault),
          ok: 'Harvested',
        },
      ]
    : [];
  const panel = l ? (
    <ContagianTrade
      token={l.token}
      symbol={l.symbol}
      quote={l.quote}
      underParity={underParity}
      tax={{buyBps: l.buyBps, sellBps: l.sellBps}}
      onDone={() => {
        setSheet(false);
        load();
      }}
    />
  ) : null;

  return (
    <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <p role="note" className="mb-4 border-l-2 border-brass-500 pl-3 text-[13px] leading-5 text-ink-300">
        {l ? (
          <>
            A Contagian token: it tends to 1 {l.peg.symbol}. Over parity buyers pay and sellers don't; under it sellers pay and buyers
            don't. It lives in one plain Uniswap v4 pool against {q}, and buying here is one swap, so one transfer of the token.{' '}
          </>
        ) : (
          'A Contagian token: a memecoin that tends to its peg. '
        )}
        <Link to="/contagian" className="text-brass-400 underline-offset-4 hover:underline">
          How Contagian works
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
            <Badge tone="brass">Contagian</Badge>
            <span title="Updates every couple of seconds, no refresh needed">
              <Heartbeat every={TICK} beat={beat} label={head !== null ? `live · #${head.toString()}` : 'live'} />
            </span>
            <dl className="num ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <Stat k="price" v={`${shown(l.spot, price)} ${q}`} n={l.spot} />
              <Stat k="of parity" v={shown(where.pct, ofParity)} n={where.pct} tone={where.tone} />
              <Stat k="parity" v={`${shown(l.parity, price)} ${q}`} n={l.parity} plain />
              <Stat k="tax buy" v={bp(l.buyBps)} n={l.buyBps} plain />
              <Stat k="sell" v={bp(l.sellBps)} n={l.sellBps} plain />
              <Stat k="tolls" v={shown(l.tolls, n => num(n, 2))} n={l.tolls} tone="text-brass-300" plain />
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(l.token);
                  toast('Address copied');
                }}
                className="rounded border border-ink-800 px-2 py-0.5 text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200 active:translate-y-px active:bg-ink-850 focus-visible:outline-brass-400"
                title={l.token}>
                {short(l.token)} ⧉
              </button>
              <a href={`${BRAND.explorer}/address/${l.token}`} target="_blank" rel="noreferrer" className="text-ink-500 hover:text-ink-200">
                explorer ↗
              </a>
              <a href={`${BRAND.explorer}/address/${l.vault}`} target="_blank" rel="noreferrer" className="text-ink-500 hover:text-ink-200">
                vault ↗
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
                className="rounded border border-ink-800 px-2 py-0.5 text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200 active:translate-y-px active:bg-ink-850 focus-visible:outline-brass-400">
                share
              </button>
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
          {l && trades ? (
            <CurveChart
              trades={trades}
              symbol={l.symbol}
              quote={q}
              parity={l.parity}
              headline={where.pct !== null ? <span className={`num text-sm ${where.tone}`}>{ofParity(where.pct)} of parity</span> : undefined}
            />
          ) : (
            <Skeleton className="h-72 w-full" />
          )}

          {l ? (
            <section className="rounded-lg border border-ink-800 bg-ink-900 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className={`text-[13px] font-medium ${where.tone}`}>{where.line || 'Measured against parity'}</p>
                <p className="num text-[13px] text-ink-400">
                  parity 1 {l.peg.symbol} = {shown(l.parity, price)} {q} · opened at {price(tickPrice(l.openTick, l.quote.decimals))} {q}
                </p>
              </div>
              <p className="measure mt-2 text-[13px] text-ink-500">
                Parity is one {l.peg.symbol} per token, in {q}, and it follows what {l.peg.symbol} is worth. The tax shown is the lagging rate
                each side would pay now; a trade also pays for its own push, up to 50%. A buy pays in kind. A sale pays on top: the pool is
                paid in full and the tax comes out of what the seller has left, so a whole balance cannot be sold while the sell tax is on.
              </p>
              {l.description && <p className="measure mt-3 text-sm text-ink-200">{l.description}</p>}
              <p className="num mt-2 text-[12px] text-ink-500">
                created by{' '}
                <a href={`${BRAND.explorer}/address/${l.creator}`} target="_blank" rel="noreferrer" className="text-brass-400 hover:underline">
                  {short(l.creator)}
                </a>{' '}
                · {ago(l.launchedAt)} ago
              </p>
            </section>
          ) : (
            <Skeleton className="h-36 w-full" />
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <section aria-labelledby="ctg-token-activity-h" className="min-w-0">
              <LiveHeading id="ctg-token-activity-h" right={<ActivityBeat beat={activity.beat} />}>
                Activity
              </LiveHeading>
              <div className="mt-2">
                <ActivityFeed {...activity} rows={8} showToken={false} empty="Nothing yet. Every trade, gotchya, payout and claim on this token shows up here as it lands." />
              </div>
            </section>
            <section aria-labelledby="ctg-token-leaders-h" className="min-w-0">
              <LiveHeading id="ctg-token-leaders-h">Bad beats</LiveHeading>
              <div className="mt-2">
                <LeaderTable
                  rows={rows}
                  status={tax.status}
                  error={tax.error}
                  retry={tax.retry}
                  unit={q}
                  show={8}
                  you={wallet.address}
                  empty="Nobody has been burned on this token yet. The wallets that pay the tax are listed here, and half of what it sells for goes to them."
                />
              </div>
            </section>
          </div>
          <p className="measure text-[12px] leading-5 text-ink-500">
            Bad beats are ranked by tax paid in total, earning or still waiting, from the vault's own record of every payment. Beside each
            wallet: the part that is earning, its share of everything earning, and what it could claim now. The other half of every payout
            goes to holders, by balance.
          </p>

          {l?.gotchya && (
            <section aria-labelledby="gotchya-h" className="rounded-lg border border-ink-800 bg-ink-900 p-4">
              <LiveHeading
                id="gotchya-h"
                right={
                  gotchya ? (
                    <span className="num text-[12px] text-ink-500">
                      last sent to {short(gotchya.who, 3)}
                      {gotchya.ts ? ` · ${ago(gotchya.ts)} ago` : ''} · {amt(gotchya.worth ?? 0)} {q} burned
                    </span>
                  ) : undefined
                }>
                What the vault just told them
              </LiveHeading>
              <p className="measure mt-2 text-[13px] leading-6 text-ink-200">{l.gotchya}</p>
              <p className="mt-2 text-[12px] leading-5 text-ink-500">The vault's own words, read from the contract. It sends them to a wallet every time that wallet pays the tax.</p>
            </section>
          )}

          {l && <ContagianPayoff window={hour} wizardsBps={l.wizardsBps} stakersBps={l.stakersBps} now={underParity ? 'under' : overParity ? 'over' : null} stacked />}

          <section aria-labelledby="ctg-trades-h">
            <LiveHeading id="ctg-trades-h" right={trades ? <span className="num text-[12px] text-ink-500">{trades.length}</span> : undefined}>
              Trades
            </LiveHeading>
            <div className="mt-2">
              <TradesTable trades={trades} symbol={l?.symbol ?? ''} explorer={BRAND.explorer} quote={q} whoOf={t => wallets.get(t.tx)} empty="No trades yet. The first one lights the chart." />
            </div>
          </section>

          {l && (
            <details aria-labelledby="cranks-h" className="group">
              <summary className="cursor-pointer list-none text-[12px] uppercase tracking-[0.08em] text-ink-500 hover:text-ink-300">
                <span id="cranks-h">The vault&rsquo;s chores</span>{' '}
                <span className="normal-case tracking-normal text-ink-600">
                  · {l.selfRunning ? 'these run by themselves on every transfer' : 'a keeper runs these; anyone may'} · <span className="group-open:hidden">show</span>
                  <span className="hidden group-open:inline">hide</span>
                </span>
              </summary>
              <ul className="mt-2 divide-y divide-ink-850 overflow-hidden rounded-lg border border-ink-800">
                {cranks.map(c => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-ink-900 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="font-medium text-ink-100">{c.name}</p>
                      <p className="text-[13px] leading-5 text-ink-400">{c.does}</p>
                      {c.blocked && <p className="mt-1 text-[13px] leading-5 text-warn-500">{c.blocked}</p>}
                    </div>
                    <Button size="sm" variant="secondary" loading={busy === c.id} disabled={!!c.blocked} onClick={() => run(c.id, c.fn, c.ok)}>
                      {label ?? c.name}
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-[72px] lg:self-start">
          {/* on a phone the panel is the sheet behind the bar at the foot of the page */}
          <div className="hidden lg:block">{panel ?? <Skeleton className="h-80 w-full" />}</div>
          <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
            <p className="text-[13px] font-medium text-ink-200">Your place in the directory</p>
            <dl className="num mt-3 space-y-2 text-[13px]">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Earning</dt>
                <dd className="text-right text-ink-100">
                  {connected && mine ? (
                    <Flash value={mine.earning}>
                      {amt(mine.earning)} {q}
                    </Flash>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Your share of what is earning</dt>
                <dd className="text-right text-ink-100">{connected && mine ? <Flash value={mine.shareBps}>{(mine.shareBps / 100).toFixed(2)}%</Flash> : '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Waiting</dt>
                <dd className="text-right text-ink-100">
                  {connected && mine ? (
                    <>
                      <Flash value={mine.waiting} tint={false}>
                        {amt(mine.waiting)} {q}
                      </Flash>
                      {mine.waiting > 0 && (
                        <span className="text-ink-500">
                          {' · '}
                          {matured ? (
                            <span className="text-up-400">ready</span>
                          ) : (
                            <>
                              earns in <Countdown at={mine.maturesAt} />
                            </>
                          )}
                        </span>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Claimable as a bad beat</dt>
                <dd className="text-right text-ink-100">
                  {connected && mine ? <Streaming value={mine.asPayer} perSecond={rates.payer} readAt={mine.readAt} unit={q} /> : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Claimable as a holder</dt>
                <dd className="text-right text-ink-100">
                  {connected && mine ? <Streaming value={mine.asHolder} perSecond={rates.holder} readAt={mine.readAt} unit={q} /> : '—'}
                </dd>
              </div>
            </dl>
            {l && connected && matured && (
              <Button className="mt-4 w-full" variant="secondary" loading={busy === 'activate'} onClick={() => run('activate', () => contagianTx.activate(w, me, l.vault, me), 'Your entry is earning')}>
                Activate
              </Button>
            )}
            <Button
              className={`${connected && matured ? 'mt-2' : 'mt-4'} w-full`}
              variant="secondary"
              loading={busy === 'claim'}
              disabled={!l || (connected && !(mine && (mine.asPayer + mine.asHolder > 0 || matured)))}
              onClick={() => l && run('claim', () => contagianTx.claim(w, me, l.vault), `Claimed ${q}`)}>
              {wallet.status === 'wrong-chain' ? `Switch to ${BRAND.chainName}` : connected ? (l?.selfRunning ? 'Collect now' : 'Claim') : 'Connect wallet'}
            </Button>
            <p className="mt-3 text-[12px] leading-5 text-ink-500">
              {l?.selfRunning
                ? `This vault sends what it owes by itself, as transfers of the token go by. Collect now takes what has been released to your wallet so far without waiting, as a bad beat and as a holder, in ${q || 'the memequote'}.`
                : `Claim collects what has been released to your wallet so far, as a bad beat and as a holder, in ${q || 'the memequote'}, and starts a waiting entry earning if its time is up. Activate does only the second.`}
            </p>
          </div>
          <p className="measure text-[12px] leading-5 text-ink-500">
            Tax is entered against the wallet that originated the transaction, at its worth in {q || 'the memequote'} when paid. An entry starts
            earning {hour} after it is paid, and paying again before then starts the wait again, so nobody gets their own tax
            back: you are paid by whoever is burned after you. Everything the tolls sell for is split half to the bad beats, by
            how much each paid, and half to holders, by balance, and released over {hour}. Holding is free.
          </p>
        </aside>
      </div>

      {l && (
        <>
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-800 bg-ink-950/95 p-3 backdrop-blur-sm lg:hidden">
            <Button className="w-full" size="lg" onClick={() => setSheet(true)}>
              Trade {l.symbol}
            </Button>
          </div>
          {sheet && (
            <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={`Trade ${l.symbol}`}>
              <button className="anim-fade absolute inset-0 bg-ink-950/70" aria-label="Close" onClick={() => setSheet(false)} />
              <div className="anim-rise absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-xl border-t border-ink-700 bg-ink-950 p-3 pb-6">
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-700" />
                {panel}
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}
