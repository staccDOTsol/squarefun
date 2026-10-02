import type {ReactNode} from 'react';
import type {Address} from 'viem';
import {ACTIVITY_TICK, bigOnes, useActivity, type Activity} from '../lib/activity';
import {BRAND} from '../lib/brand';
import {ago, num, short} from '../lib/format';
import {useMoves, type Leader} from '../lib/leaders';
import {Link} from '../lib/router';
import {Skeleton} from './ui/Bits';
import {Flash, Heartbeat, Rank, Ticker, useArrivals} from './ui/Live';

/**
 * The live surfaces every page shares: the feed, the leaderboard, the strip under the header.
 * They are monitor rows, not cards: one line each, newest at the top, a fixed height so a list
 * going from loading to ready moves nothing around it.
 */

/** Row height in px. Feeds and boards are sized in rows so the skeleton and the content take the same space. */
const ROW = 30;

/** An amount in a quote: two places from 1 up, three significant figures under it. */
export const amt = (n: number) => (n >= 1 ? num(n, 2) : n === 0 ? '0' : n.toLocaleString(undefined, {maximumSignificantDigits: 3}));

const tones = {up: 'text-up-400', down: 'text-down-400', brass: 'text-brass-300', ink: 'text-ink-400'} as const;

/** An event in words: what happened, and how much. */
export function describe(e: Activity): {verb: string; tone: keyof typeof tones; amount: string} {
  const q = e.quoteSymbol ?? '';
  const sym = e.tokenSymbol;
  switch (e.kind) {
    case 'buy':
      return {verb: 'buy', tone: 'up', amount: `${amt(e.worth ?? 0)} ${q} · ${num(e.amountTokens)} ${sym}`};
    case 'sell':
      return {verb: 'sell', tone: 'down', amount: `${amt(e.worth ?? 0)} ${q} · ${num(e.amountTokens)} ${sym}`};
    case 'fee':
      return {verb: 'paid the square', tone: 'brass', amount: `${num(e.amountTokens, 2)} ${sym}${e.worth !== undefined ? ` · ${amt(e.worth)} ${q}` : ''}`};
    case 'gotchya':
      return {verb: 'gotchya:', tone: 'down', amount: `${short(e.who, 3)} burned ${amt(e.worth ?? 0)} ${q} · ${num(e.amountTokens, 2)} ${sym}`};
    case 'settle':
      return {verb: 'settled', tone: 'up', amount: `${num(e.amountTokens, 2)} ${sym} sold over parity for ${amt(e.worth ?? 0)} ${q}`};
    case 'reflect':
      return {verb: 'paid out:', tone: 'up', amount: `${amt(e.parts?.toPayers ?? 0)} ${q} to bad beats, ${amt(e.parts?.toHolders ?? 0)} ${q} to holders`};
    case 'yield':
      return {
        verb: 'offers earned',
        tone: 'up',
        amount: `${amt(e.worth ?? 0)} ${q}: Wizards ${amt(e.parts?.wizards ?? 0)} / stakers ${amt(e.parts?.stakers ?? 0)} / bad beats ${amt(e.parts?.payers ?? 0)}`,
      };
    case 'offer':
      return {verb: 'offered', tone: 'ink', amount: `${num(e.amountTokens, 2)} ${sym} above the price, against ${e.parts?.other ?? short(e.who, 3)}`};
    case 'harvest': {
      const other = e.parts?.other ?? short(e.who, 3);
      const took = e.parts?.otherAmount !== undefined ? `${amt(e.parts.otherAmount)} ${other}` : other;
      return {
        verb: 'harvested',
        tone: 'ink',
        amount: `${e.parts?.sold ? `an offer sold through for ${took}` : `${took} in fees`}${e.amountTokens > 0 ? ` · ${num(e.amountTokens, 2)} ${sym} back to tolls` : ''}`,
      };
    }
    case 'claim':
      return {verb: 'claimed', tone: 'up', amount: `${amt(e.worth ?? 0)} ${q}`};
    case 'launch':
      return {verb: 'launched', tone: 'brass', amount: `by ${short(e.who, 3)}`};
  }
}

const pageOf = (e: Activity) => (e.family === 'contagian' ? `/contagian/${e.token}` : `/t/${e.token}`);
/** Events whose `who` is a wallet worth linking; the others name an asset or the vault. */
const hasWallet = (e: Activity) => e.kind !== 'offer' && e.kind !== 'harvest' && e.kind !== 'reflect' && e.kind !== 'yield' && e.kind !== 'launch' && e.kind !== 'gotchya';

/** A section heading in the site's small caps, with whatever sits at its right edge (a heartbeat, a count). */
export function LiveHeading({id, children, right}: {id?: string; children: ReactNode; right?: ReactNode}) {
  return (
    <div className="flex h-6 items-center justify-between gap-3">
      <h2 id={id} className="text-[13px] font-medium uppercase tracking-wide text-ink-500">
        {children}
      </h2>
      {right}
    </div>
  );
}

/** The pulse for anything fed by the shared activity read. */
export function ActivityBeat({beat}: {beat: number}) {
  return <Heartbeat every={ACTIVITY_TICK} beat={beat} />;
}

function Quiet({rows, children}: {rows: number; children: ReactNode}) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900 px-3 py-2 text-[13px] leading-5 text-ink-500" style={{minHeight: rows * ROW}}>
      {children}
    </div>
  );
}

function Failed({rows, title, error, retry}: {rows: number; title: string; error?: string; retry: () => void}) {
  return (
    <div role="alert" className="rounded-lg border border-down-500/40 bg-down-900/40 px-3 py-2 text-[13px] leading-5" style={{minHeight: rows * ROW}}>
      <p className="font-medium text-down-400">{title}</p>
      {error && <p className="truncate text-ink-300">{error}</p>}
      <button onClick={retry} className="mt-1 text-brass-400 underline-offset-4 hover:underline active:text-brass-300 focus-visible:outline-brass-400">
        Try again
      </button>
    </div>
  );
}

function Loading({rows}: {rows: number}) {
  return (
    <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-900" style={{height: rows * ROW}} aria-busy>
      {Array.from({length: rows}, (_, i) => (
        <div key={i} className="flex items-center gap-2 border-b border-ink-850 px-3" style={{height: ROW}}>
          <Skeleton className="h-3 w-6" />
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 flex-1" />
        </div>
      ))}
    </div>
  );
}

/**
 * A feed: newest first, `rows` tall, scrolling inside itself. A row that was not there on the
 * last read drops in with a brass tint; one in the top tenth by size is jolted.
 */
export function ActivityFeed({
  events,
  status,
  error,
  retry,
  rows = 10,
  limit = 60,
  showToken = true,
  empty,
}: {
  events: Activity[];
  status: 'loading' | 'ready' | 'error';
  error?: string;
  retry: () => void;
  rows?: number;
  limit?: number;
  showToken?: boolean;
  empty: string;
}) {
  const shown = events.slice(0, limit);
  const arrival = useArrivals(
    shown.map(e => e.id),
    status === 'ready',
  );
  const big = bigOnes(events);
  if (status === 'loading') return <Loading rows={rows} />;
  if (status === 'error') return <Failed rows={rows} title="Could not read the activity" error={error} retry={retry} />;
  if (shown.length === 0) return <Quiet rows={rows}>{empty}</Quiet>;
  return (
    <ol className="num overflow-y-auto overflow-x-hidden rounded-lg border border-ink-800 bg-ink-900 text-[12px]" style={{height: rows * ROW}} aria-live="off">
      {shown.map(e => {
        const d = describe(e);
        return (
          <li key={e.id} className={`flex items-center gap-2 border-b border-ink-850 px-3 ${big.has(e.id) ? 'font-medium' : ''} ${arrival(e.id, big.has(e.id))}`} style={{height: ROW}}>
            <a href={`${BRAND.explorer}/tx/${e.txHash}`} target="_blank" rel="noreferrer" className="w-7 shrink-0 text-ink-500 hover:text-ink-200" title="Open the transaction">
              {e.ts ? ago(e.ts) : '·'}
            </a>
            {showToken && (
              <Link to={pageOf(e)} className="max-w-24 shrink-0 truncate text-ink-100 hover:text-brass-300">
                ${e.tokenSymbol}
              </Link>
            )}
            <span className={`shrink-0 ${tones[d.tone]}`}>{d.verb}</span>
            <span className="min-w-0 flex-1 truncate text-ink-200" title={d.amount}>
              {d.amount}
            </span>
            {hasWallet(e) && (
              <a href={`${BRAND.explorer}/address/${e.who}`} target="_blank" rel="noreferrer" className="shrink-0 text-ink-500 hover:text-ink-200">
                {short(e.who, 3)}
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export type LeaderRow = Leader & {
  /** a second figure after the address: which part is earning, a share, what can be claimed */
  note?: ReactNode;
};

/**
 * A leaderboard: place, wallet, amount. A place that moved shows an arrow and flashes, an amount
 * that grew rolls and tints, and a wallet new to the board drops in.
 */
export function LeaderTable({
  rows,
  status,
  error,
  retry,
  unit,
  show = 8,
  limit = 25,
  empty,
  you,
}: {
  rows: LeaderRow[];
  status: 'loading' | 'ready' | 'error';
  error?: string;
  retry: () => void;
  /** what the amount is in */
  unit: string;
  /** rows tall */
  show?: number;
  limit?: number;
  empty: string;
  /** the connected wallet, marked on the board */
  you?: Address;
}) {
  const shown = rows.slice(0, limit);
  const keys = shown.map(r => r.who.toLowerCase());
  const was = useMoves(keys);
  const arrival = useArrivals(keys, status === 'ready');
  if (status === 'loading') return <Loading rows={show} />;
  if (status === 'error') return <Failed rows={show} title="Could not read the leaderboard" error={error} retry={retry} />;
  if (shown.length === 0) return <Quiet rows={show}>{empty}</Quiet>;
  return (
    <ol className="num overflow-y-auto overflow-x-hidden rounded-lg border border-ink-800 bg-ink-900 text-[12px]" style={{height: show * ROW}}>
      {shown.map((r, i) => {
        const k = r.who.toLowerCase();
        const mine = you?.toLowerCase() === k;
        return (
          <li key={k} className={`flex items-center gap-2 border-b border-ink-850 px-3 ${arrival(k)}`} style={{height: ROW}}>
            <Rank place={i + 1} was={was(k)} />
            <a href={`${BRAND.explorer}/address/${r.who}`} target="_blank" rel="noreferrer" className={`shrink-0 hover:text-brass-300 ${mine ? 'text-brass-300' : 'text-ink-200'}`}>
              {short(r.who, 3)}
              {mine ? ' (you)' : ''}
            </a>
            <span className="min-w-0 flex-1 truncate text-ink-500">{r.note}</span>
            <Flash value={r.amount} className="shrink-0 text-ink-100">
              {amt(r.amount)} {unit}
            </Flash>
          </li>
        );
      })}
    </ol>
  );
}

function TickerItem({e}: {e: Activity}) {
  const d = describe(e);
  return (
    <Link to={pageOf(e)} className="num flex shrink-0 items-baseline gap-1.5 whitespace-nowrap hover:text-ink-100">
      <span className="text-ink-100">${e.tokenSymbol}</span>
      <span className={tones[d.tone]}>{d.verb}</span>
      <span className="text-ink-300">{d.amount}</span>
      <span className="text-ink-500">{e.ts ? `${ago(e.ts)} ago` : ''}</span>
    </Link>
  );
}

/**
 * The strip under the header on every page: the latest things on the site, scrolling past.
 * With fewer than four there is nothing to scroll, so it is not shown; while the first read is
 * out, its space is held so the page below does not jump when it arrives.
 */
export function SiteTicker() {
  const {events, status} = useActivity();
  const items = events.slice(0, 24);
  if (status === 'loading') return <div className="h-8 border-y border-ink-800 bg-ink-900/60" aria-hidden />;
  if (items.length < 4) return null;
  return (
    <Ticker seconds={Math.max(30, items.length * 5)}>
      {items.map(e => (
        <TickerItem key={e.id} e={e} />
      ))}
    </Ticker>
  );
}
