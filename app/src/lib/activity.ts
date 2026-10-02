import {useEffect, useMemo, useSyncExternalStore} from 'react';
import {formatEther, parseAbi, type Address, type Hex} from 'viem';
import {ADDR, blockTimestamp, curveAbi, once, publicClient, scan, tokenAbi} from './chain';
import {LAUNCHERS, assetOf, contagianDeployed, isHidden, launcherAbi, poolOf, referenceEvent, swapEvent, swapSides, vaultEventAbi, type Asset} from './contagian';
import {data} from './data';
import {useLive} from './live';

/**
 * One stream of what just happened, for the whole site.
 *
 * Square and Pools tokens: the same logs the token page reads (curve trades, pool swaps,
 * Reference events). Contagian tokens: their vaults' events (all but the `Gotchya` note, which
 * repeats `Paid` with a long string attached) and the launcher's.
 *
 * Every source is a remembered scan: history is read once per browser, and every read after
 * that asks only for the blocks since. Each scan keeps the newest events and, where a
 * leaderboard needs them, running totals per wallet, so the feed and the leaderboards come from
 * the same logs and cost one read. One poller serves every component on the page.
 */

/**
 * `gotchya`: a wallet paid the Contagian tax (the vault's `Paid`, which it emits beside its
 * `Gotchya` note with the same wallet and amounts). `reflect`: what tolls sold for, paid out to
 * the bad beats and to holders. `offer`: a tranche of tolls put on sale above the price.
 */
export type ActivityKind = 'buy' | 'sell' | 'fee' | 'gotchya' | 'settle' | 'offer' | 'harvest' | 'reflect' | 'yield' | 'claim' | 'launch';
export type Family = 'square' | 'contagian';

export interface Activity {
  /** txHash:logIndex */
  id: string;
  /** ms */
  ts: number;
  block: bigint;
  token: Address;
  tokenSymbol: string;
  kind: ActivityKind;
  /** who did it; for `offer` and `harvest` the other asset, for `reflect` and `yield` the vault */
  who: Address;
  amountTokens: number;
  /** its size in the quote: ETH for Square and Pools tokens, the memequote for Contagian */
  worth?: number;
  quoteSymbol?: string;
  txHash: Hex;
  family: Family;
  /**
   * reflect: the two halves; yield: the three shares; offer and harvest: the other asset's symbol;
   * harvest: what came out in the other asset, and whether it was an offer that sold through or fees
   */
  parts?: {toPayers?: number; toHolders?: number; wizards?: number; stakers?: number; payers?: number; other?: string; otherAmount?: number; sold?: boolean};
}

export type VaultInfo = {token: Address; vault: Address; symbol: string; quote: Asset};
type Status = 'loading' | 'ready' | 'error';

interface Snapshot {
  /** goes up by one on every successful read */
  beat: number;
  /** newest first */
  events: Activity[];
  status: Record<Family, Status>;
  error: Partial<Record<Family, string>>;
  /** reference fees paid, in the token: token (lowercase) → payer (lowercase) → amount */
  squareFees: Record<string, Record<string, number>>;
  /** tax paid in total, earning or not, in the memequote: vault (lowercase) → originator (lowercase) → amount */
  contagianPaid: Record<string, Record<string, number>>;
  /** swaps in each Contagian token's pool since the launcher was deployed: token (lowercase) → count */
  contagianSwaps: Record<string, number>;
  vaults: VaultInfo[];
}

/** How often the page asks for new blocks. Robinhood blocks are 250 ms; two seconds is eight of them. */
export const ACTIVITY_TICK = 2000;
/** Kept per token and per source, and in all: a few hundred events in memory, whatever the history. */
const PER_TOKEN = 80;
const TOTAL = 400;
/** The merged list every view filters: the newest of all sources. */
const KEPT = 600;
/** With no deploy block on record for the Contagian launcher, look back this far (about six days). */
const CONTAGIAN_LOOKBACK = 2_000_000n;

const swapAbi = parseAbi([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);

const f = (x: bigint) => Number(formatEther(x));
const abs = (x: bigint) => (x < 0n ? -x : x);
type Stamped = {transactionHash: Hex; logIndex: number; blockNumber: bigint; blockTimestamp?: bigint | null};
const head = (l: Stamped) => ({
  id: `${l.transactionHash}:${l.logIndex}`,
  tx: l.transactionHash,
  block: Number(l.blockNumber),
  // dRPC puts the time on the log; an RPC that does not is asked for the block once, below
  ts: Number(l.blockTimestamp ?? 0n) * 1000,
});

/** The newest `total` of an oldest-first list, at most `perKey` for any one key. Oldest first again. */
function trim<T>(list: T[], keyOf: (x: T) => string, perKey = PER_TOKEN, total = TOTAL): T[] {
  const counts = new Map<string, number>();
  const keep: T[] = [];
  for (let i = list.length - 1; i >= 0 && keep.length < total; i--) {
    const k = keyOf(list[i]);
    const n = counts.get(k) ?? 0;
    if (n >= perKey) continue;
    counts.set(k, n + 1);
    keep.push(list[i]);
  }
  return keep.reverse();
}

const symbolOf = (token: Address) =>
  once(`symbol:${token.toLowerCase()}`, () => publicClient.readContract({address: token, abi: tokenAbi, functionName: 'symbol'})).catch(() => 'TOKEN');

async function stamped<T extends {block: number; ts: number}>(rows: T[]): Promise<T[]> {
  if (rows.every(r => r.ts)) return rows;
  return Promise.all(rows.map(async r => (r.ts ? r : {...r, ts: await blockTimestamp(BigInt(r.block)).catch(() => 0)})));
}

// ─── Square and Pools tokens ──────────────────────────────────────────────

type RawTrade = {id: string; tx: Hex; block: number; ts: number; token: Address; side: 'buy' | 'sell'; quote: number; tokens: number; who: Address};
type RawRef = {id: string; tx: Hex; block: number; ts: number; token: Address; from: Address; to: Address; fee: number};
type RefState = {recent: RawRef[]; paid: Record<string, Record<string, number>>};

async function readSquare(to: bigint): Promise<{events: Activity[]; fees: Snapshot['squareFees']}> {
  if (!data.deployed) return {events: [], fees: {}};
  // the roster is read to the same block as the logs, so a token is always listed before its logs are counted
  const roster = await data.roster(to);
  const tokens = [...roster.pad.map(p => p.token), ...roster.pools.map(p => p.token)];
  if (tokens.length === 0) return {events: [], fees: {}};
  const curves = roster.pad.map(p => p.curve);
  const byCurve = new Map(roster.pad.map(p => [p.curve.toLowerCase(), p.token]));
  const byPool = new Map(roster.pools.map(p => [p.id.toLowerCase(), p.token]));
  const byLower = new Map(tokens.map(t => [t.toLowerCase(), t]));
  const manager = ADDR.poolManager.toLowerCase();
  // a transfer out of a venue is a buy, and the one receiving it paid the fee; otherwise the sender did
  const venues = new Set([manager, ...curves.map(c => c.toLowerCase())]);

  const [curveTrades, swaps, refs, symbols] = await Promise.all([
    curves.length
      ? scan({
          key: 'act1:curve-trades',
          read: (a, b) => publicClient.getLogs({address: curves, events: [curveAbi[0], curveAbi[1]], fromBlock: a, toBlock: b}),
          addresses: curves.length,
          from: BigInt(ADDR.deployBlock),
          to,
          init: [] as RawTrade[],
          fold: (acc, logs) =>
            trim(
              [
                ...acc,
                ...logs.flatMap(l => {
                  const token = byCurve.get(l.address.toLowerCase());
                  if (!token) return [];
                  const buy = l.eventName === 'CurveBuy';
                  const a = l.args as {quoteIn?: bigint; tokensOut?: bigint; tokensIn?: bigint; quoteOut?: bigint; buyer?: Address; seller?: Address};
                  const row: RawTrade = {...head(l), token, side: buy ? 'buy' : 'sell', quote: f((buy ? a.quoteIn : a.quoteOut) ?? 0n), tokens: f((buy ? a.tokensOut : a.tokensIn) ?? 0n), who: (buy ? a.buyer : a.seller)!};
                  return [row];
                }),
              ],
              t => t.token,
            ),
        })
      : ([] as RawTrade[]),
    roster.pools.length
      ? scan({
          key: 'act1:pool-swaps',
          read: (a, b) => publicClient.getLogs({address: ADDR.poolManager, event: swapAbi[0], args: {id: roster.pools.map(p => p.id)}, fromBlock: a, toBlock: b}),
          from: roster.pools.reduce((m, p) => (p.block < m ? p.block : m), roster.pools[0].block),
          to,
          init: [] as RawTrade[],
          fold: (acc, logs) =>
            trim(
              [
                ...acc,
                ...logs.flatMap(l => {
                  const token = byPool.get((l.args.id ?? '').toLowerCase());
                  if (!token) return [];
                  // ETH is currency0: a negative amount0 is ETH paid in, so a buy (the token page reads it the same way)
                  const a0 = l.args.amount0 ?? 0n;
                  const row: RawTrade = {...head(l), token, side: a0 < 0n ? 'buy' : 'sell', quote: f(abs(a0)), tokens: f(abs(l.args.amount1 ?? 0n)), who: l.args.sender!};
                  return [row];
                }),
              ],
              t => t.token,
            ),
        })
      : ([] as RawTrade[]),
    scan({
      key: 'act1:refs',
      read: (a, b) => publicClient.getLogs({address: tokens, event: tokenAbi[0], fromBlock: a, toBlock: b}),
      addresses: tokens.length,
      from: BigInt(ADDR.deployBlock),
      to,
      init: {recent: [], paid: {}} as RefState,
      fold: (acc, logs) => {
        const paid = {...acc.paid};
        const fresh: RawRef[] = [];
        for (const l of logs) {
          const k = l.address.toLowerCase();
          const token = byLower.get(k);
          if (!token) continue;
          const fee = f(l.args.fee ?? 0n);
          const from = l.args.from!;
          const dest = l.args.to!;
          fresh.push({...head(l), token, from, to: dest, fee});
          if (fee > 0) {
            const payer = (venues.has(from.toLowerCase()) ? dest : from).toLowerCase();
            paid[k] = {...paid[k], [payer]: (paid[k]?.[payer] ?? 0) + fee};
          }
        }
        return {recent: trim([...acc.recent, ...fresh], r => r.token, PER_TOKEN * 2, TOTAL * 2), paid};
      },
    }),
    Promise.all(tokens.map(symbolOf)),
  ]);
  const symbol = new Map(tokens.map((t, i) => [t.toLowerCase(), symbols[i]]));

  // a pool swap names the router; the token's own transfer in the same transaction names the wallet
  const party = new Map<string, {buyer?: Address; seller?: Address}>();
  for (const r of refs.recent) {
    const k = `${r.tx}:${r.token.toLowerCase()}`;
    const p = party.get(k) ?? {};
    if (r.from.toLowerCase() === manager) p.buyer = r.to;
    else if (r.to.toLowerCase() === manager) p.seller = r.from;
    party.set(k, p);
  }
  // the newest trade prices a token, so a fee paid in it can be sized in ETH
  const price = new Map<string, number>();
  const trades = [...curveTrades, ...swaps].sort((a, b) => a.block - b.block);
  for (const t of trades) if (t.tokens > 0) price.set(t.token.toLowerCase(), t.quote / t.tokens);

  const [stampedTrades, stampedRefs] = await Promise.all([stamped(trades), stamped(refs.recent.filter(r => r.fee > 0))]);
  const events: Activity[] = [
    ...stampedTrades.map(t => {
      const p = party.get(`${t.tx}:${t.token.toLowerCase()}`);
      return {
        id: t.id,
        ts: t.ts,
        block: BigInt(t.block),
        token: t.token,
        tokenSymbol: symbol.get(t.token.toLowerCase()) ?? 'TOKEN',
        kind: t.side,
        who: (t.side === 'buy' ? p?.buyer : p?.seller) ?? t.who,
        amountTokens: t.tokens,
        worth: t.quote,
        quoteSymbol: 'ETH',
        txHash: t.tx,
        family: 'square' as const,
      };
    }),
    ...stampedRefs.map(r => {
      const p = price.get(r.token.toLowerCase());
      return {
        id: r.id,
        ts: r.ts,
        block: BigInt(r.block),
        token: r.token,
        tokenSymbol: symbol.get(r.token.toLowerCase()) ?? 'TOKEN',
        kind: 'fee' as const,
        who: venues.has(r.from.toLowerCase()) ? r.to : r.from,
        amountTokens: r.fee,
        worth: p === undefined ? undefined : r.fee * p,
        quoteSymbol: p === undefined ? undefined : 'ETH',
        txHash: r.tx,
        family: 'square' as const,
      };
    }),
  ];
  return {events, fees: refs.paid};
}

// ─── Contagian ────────────────────────────────────────────────────────────

type RawLaunch = {id: string; tx: Hex; block: number; ts: number; token: Address; vault: Address; creator: Address; quote: Address};
type VaultEvent = 'Paid' | 'Settled' | 'Offered' | 'Harvested' | 'Reflected' | 'Yield' | 'Claimed';
type RawVault = {id: string; tx: Hex; block: number; ts: number; vault: string; name: VaultEvent; who: Address | null; x: bigint[]; sold?: boolean};
type VaultState = {recent: RawVault[]; paid: Record<string, Record<string, bigint>>};
type RawSwap = {id: string; tx: Hex; block: number; ts: number; token: Address; buy: boolean; quoteRaw: bigint; tokensRaw: bigint; sender: Address};
type SwapState = {recent: RawSwap[]; counts: Record<string, number>};
type RawParty = {tx: Hex; block: number; token: string; from: Address; to: Address};
type ContagianRead = {events: Activity[]; paid: Snapshot['contagianPaid']; swaps: Snapshot['contagianSwaps']; vaults: VaultInfo[]};
const noContagian: ContagianRead = {events: [], paid: {}, swaps: {}, vaults: []};

let contagianFrom: bigint | null = null;
/** Every launcher, as one scan key: a launcher added later starts the scans again from the first block. */
const ALL = LAUNCHERS.join();

async function readContagian(to: bigint): Promise<ContagianRead> {
  if (!contagianDeployed) return noContagian;
  if (contagianFrom === null) {
    const floor = to > CONTAGIAN_LOOKBACK ? to - CONTAGIAN_LOOKBACK : 0n;
    contagianFrom = ADDR.contagian?.deployBlock !== undefined ? BigInt(ADDR.contagian.deployBlock) : floor;
  }
  const from = contagianFrom;
  const launches = await scan({
    key: `act1:contagian-launched:${ALL}`,
    read: (a, b) => publicClient.getLogs({address: LAUNCHERS, event: launcherAbi[0], fromBlock: a, toBlock: b}),
    addresses: LAUNCHERS.length,
    from,
    to,
    init: [] as RawLaunch[],
    fold: (acc, logs) => [...acc, ...logs.map(l => ({...head(l), token: l.args.token!, vault: l.args.vault!, creator: l.args.creator!, quote: l.args.quote!}))],
  });
  if (launches.length === 0) return noContagian;
  const vaults = launches.map(l => l.vault);
  const tokens = launches.map(l => l.token);
  // each token's pool with its memequote: the swaps in it are its buys and sells
  const pools = new Map(launches.map(l => [poolOf(l.token, l.quote).id.toLowerCase(), {token: l.token, tokenIs0: poolOf(l.token, l.quote).tokenIs0}]));
  const manager = ADDR.poolManager.toLowerCase();
  const [state, swaps, parties, infos] = await Promise.all([
    scan({
      key: `act2:contagian-vaults:${ALL}`,
      read: (a, b) => publicClient.getLogs({address: vaults, events: vaultEventAbi, fromBlock: a, toBlock: b}),
      addresses: vaults.length,
      from,
      to,
      init: {recent: [], paid: {}} as VaultState,
      fold: (acc, logs) => {
        const paid = {...acc.paid};
        const fresh: RawVault[] = [];
        for (const l of logs) {
          const vault = l.address.toLowerCase();
          const base = {...head(l), vault};
          if (l.eventName === 'Paid') {
            const who = l.args.originator!;
            const worth = l.args.worth ?? 0n;
            fresh.push({...base, name: 'Paid', who, x: [l.args.tolls ?? 0n, worth]});
            const k = who.toLowerCase();
            paid[vault] = {...paid[vault], [k]: (paid[vault]?.[k] ?? 0n) + worth};
          } else if (l.eventName === 'Settled') {
            fresh.push({...base, name: 'Settled', who: l.args.caller!, x: [l.args.tolls ?? 0n, l.args.quoteIn ?? 0n, l.args.tip ?? 0n]});
          } else if (l.eventName === 'Offered') {
            fresh.push({...base, name: 'Offered', who: l.args.other!, x: [l.args.tolls ?? 0n]});
          } else if (l.eventName === 'Harvested') {
            fresh.push({...base, name: 'Harvested', who: l.args.other!, x: [l.args.tokens ?? 0n, l.args.otherAmount ?? 0n], sold: !!l.args.sold});
          } else if (l.eventName === 'Reflected') {
            fresh.push({...base, name: 'Reflected', who: null, x: [l.args.toPayers ?? 0n, l.args.toHolders ?? 0n]});
          } else if (l.eventName === 'Yield') {
            fresh.push({...base, name: 'Yield', who: null, x: [l.args.toWizards ?? 0n, l.args.toStakers ?? 0n, l.args.toPayers ?? 0n]});
          } else if (l.eventName === 'Claimed') {
            fresh.push({...base, name: 'Claimed', who: l.args.who!, x: [l.args.amount ?? 0n]});
          }
        }
        return {recent: trim([...acc.recent, ...fresh], r => r.vault), paid};
      },
    }),
    scan({
      key: `act1:contagian-swaps:${ALL}`,
      read: (a, b) => publicClient.getLogs({address: ADDR.poolManager, event: swapEvent, args: {id: [...pools.keys()] as Hex[]}, fromBlock: a, toBlock: b}),
      from,
      to,
      init: {recent: [], counts: {}} as SwapState,
      fold: (acc, logs) => {
        const counts = {...acc.counts};
        const fresh: RawSwap[] = [];
        for (const l of logs) {
          const pool = pools.get((l.args.id ?? '').toLowerCase());
          if (!pool) continue;
          const k = pool.token.toLowerCase();
          counts[k] = (counts[k] ?? 0) + 1;
          fresh.push({...head(l), token: pool.token, ...swapSides(pool.tokenIs0, l.args.amount0 ?? 0n, l.args.amount1 ?? 0n), sender: l.args.sender!});
        }
        return {recent: trim([...acc.recent, ...fresh], r => r.token), counts};
      },
    }),
    // the token's own transfers in and out of the pool manager: they name the wallet a swap was for
    scan({
      key: `act1:contagian-parties:${ALL}`,
      read: (a, b) => publicClient.getLogs({address: tokens, event: referenceEvent, fromBlock: a, toBlock: b}),
      addresses: tokens.length,
      from,
      to,
      init: [] as RawParty[],
      fold: (acc, logs) =>
        trim(
          [
            ...acc,
            ...logs.flatMap(l => {
              const src = l.args.from!;
              const dest = l.args.to!;
              if (src.toLowerCase() !== manager && dest.toLowerCase() !== manager) return [];
              const row: RawParty = {tx: l.transactionHash, block: Number(l.blockNumber), token: l.address.toLowerCase(), from: src, to: dest};
              return [row];
            }),
          ],
          r => r.token,
          PER_TOKEN * 2,
          TOTAL * 2,
        ),
    }),
    // A hidden token is read like any other (so nothing is missing if it is shown again) and
    // dropped here: everything below is keyed by these, so its launch, its vault's events, its
    // swaps and its totals never reach a feed, the ticker or a leaderboard.
    Promise.all(launches.filter(l => !isHidden(l.token)).map(async l => ({token: l.token, vault: l.vault, symbol: await symbolOf(l.token), quote: await assetOf(l.quote)}))),
  ]);
  const info = new Map(infos.map(i => [i.vault.toLowerCase(), i]));
  // the asset a tranche was offered against, or a range was collected in: named and sized, not shown as an address
  const others = [...new Set(state.recent.filter(r => (r.name === 'Offered' || r.name === 'Harvested') && r.who).map(r => r.who!))];
  const named = new Map(await Promise.all(others.map(async a => [a.toLowerCase(), await assetOf(a).catch(() => null)] as const)));

  const [recent, launched, swapped] = await Promise.all([stamped(state.recent), stamped(launches), stamped(swaps.recent)]);
  // The wallet behind a swap: whoever the vault entered the tax against in that transaction, when
  // it took any; else the wallet the token moved to or from; else the swap's sender (a router).
  const burned = new Map(state.recent.filter(r => r.name === 'Paid' && r.who).map(r => [`${r.tx}:${r.vault}`, r.who!]));
  const party = new Map<string, {buyer?: Address; seller?: Address}>();
  for (const r of parties) {
    const k = `${r.tx}:${r.token}`;
    const p = party.get(k) ?? {};
    if (r.from.toLowerCase() === manager) p.buyer = r.to;
    else p.seller = r.from;
    party.set(k, p);
  }
  const byToken = new Map(infos.map(i => [i.token.toLowerCase(), i]));
  const events: Activity[] = launched.filter(l => info.has(l.vault.toLowerCase())).map(l => ({
    id: l.id,
    ts: l.ts,
    block: BigInt(l.block),
    token: l.token,
    tokenSymbol: info.get(l.vault.toLowerCase())?.symbol ?? 'TOKEN',
    kind: 'launch' as const,
    who: l.creator,
    amountTokens: 1_000_000_000,
    txHash: l.tx,
    family: 'contagian' as const,
  }));
  for (const r of recent) {
    const i = info.get(r.vault);
    if (!i) continue;
    const unit = 10 ** i.quote.decimals;
    const q = (v: bigint) => Number(v) / unit;
    const base = {id: r.id, ts: r.ts, block: BigInt(r.block), token: i.token, tokenSymbol: i.symbol, txHash: r.tx, family: 'contagian' as const, quoteSymbol: i.quote.symbol};
    const other = r.who ? named.get(r.who.toLowerCase()) : null;
    if (r.name === 'Paid') events.push({...base, kind: 'gotchya', who: r.who!, amountTokens: f(r.x[0]), worth: q(r.x[1])});
    else if (r.name === 'Settled') events.push({...base, kind: 'settle', who: r.who!, amountTokens: f(r.x[0]), worth: q(r.x[1])});
    else if (r.name === 'Offered') events.push({...base, kind: 'offer', who: r.who!, amountTokens: f(r.x[0]), quoteSymbol: undefined, parts: {other: other?.symbol}});
    else if (r.name === 'Harvested') {
      const inQuote = r.who!.toLowerCase() === i.quote.address.toLowerCase();
      events.push({
        ...base,
        kind: 'harvest',
        who: r.who!,
        amountTokens: f(r.x[0]),
        worth: inQuote ? q(r.x[1]) : undefined,
        quoteSymbol: inQuote ? i.quote.symbol : undefined,
        parts: {other: other?.symbol, otherAmount: other ? Number(r.x[1]) / 10 ** other.decimals : undefined, sold: r.sold},
      });
    } else if (r.name === 'Reflected') events.push({...base, kind: 'reflect', who: i.vault, amountTokens: 0, worth: q(r.x[0] + r.x[1]), parts: {toPayers: q(r.x[0]), toHolders: q(r.x[1])}});
    else if (r.name === 'Yield')
      events.push({...base, kind: 'yield', who: i.vault, amountTokens: 0, worth: q(r.x[0] + r.x[1] + r.x[2]), parts: {wizards: q(r.x[0]), stakers: q(r.x[1]), payers: q(r.x[2])}});
    else if (r.name === 'Claimed') events.push({...base, kind: 'claim', who: r.who!, amountTokens: 0, worth: q(r.x[0])});
  }
  for (const s of swapped) {
    const i = byToken.get(s.token.toLowerCase());
    if (!i) continue;
    const p = party.get(`${s.tx}:${s.token.toLowerCase()}`);
    events.push({
      id: s.id,
      ts: s.ts,
      block: BigInt(s.block),
      token: i.token,
      tokenSymbol: i.symbol,
      kind: s.buy ? 'buy' : 'sell',
      who: burned.get(`${s.tx}:${i.vault.toLowerCase()}`) ?? (s.buy ? p?.buyer : p?.seller) ?? s.sender,
      amountTokens: f(s.tokensRaw),
      worth: Number(s.quoteRaw) / 10 ** i.quote.decimals,
      quoteSymbol: i.quote.symbol,
      txHash: s.tx,
      family: 'contagian',
    });
  }
  const paid: Snapshot['contagianPaid'] = {};
  for (const [vault, by] of Object.entries(state.paid)) {
    const i = info.get(vault);
    if (!i) continue;
    const unit = 10 ** i.quote.decimals;
    paid[vault] = Object.fromEntries(Object.entries(by).map(([who, v]) => [who, Number(v) / unit]));
  }
  return {events, paid, swaps: Object.fromEntries(Object.entries(swaps.counts).filter(([token]) => byToken.has(token))), vaults: infos};
}

// ─── the store: one snapshot, one poller ──────────────────────────────────

let snapshot: Snapshot = {
  beat: 0,
  events: [],
  // with no launcher there is nothing to wait for: Contagian is ready and empty
  status: {square: data.deployed ? 'loading' : 'ready', contagian: contagianDeployed ? 'loading' : 'ready'},
  error: {},
  squareFees: {},
  contagianPaid: {},
  contagianSwaps: {},
  vaults: [],
};
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
const getSnapshot = () => snapshot;
/** The store as it stands, for code that is not a component. */
export const peekActivity = getSnapshot;

let kept: Record<Family, Activity[]> = {square: [], contagian: []};
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message.split('\n')[0].slice(0, 160) : fallback);

async function read() {
  let to: bigint;
  try {
    to = await publicClient.getBlockNumber();
  } catch (e) {
    const failed = (s: Status): Status => (s === 'ready' ? 'ready' : 'error');
    snapshot = {
      ...snapshot,
      status: {square: failed(snapshot.status.square), contagian: failed(snapshot.status.contagian)},
      error: {square: message(e, 'Could not read the chain'), contagian: message(e, 'Could not read the chain')},
    };
    listeners.forEach(l => l());
    return;
  }
  const [square, ctg] = await Promise.allSettled([readSquare(to), readContagian(to)]);
  const next = {...snapshot, status: {...snapshot.status}, error: {...snapshot.error}};
  // a family that failed keeps what it last showed; one that never loaded says so
  if (square.status === 'fulfilled') {
    kept = {...kept, square: square.value.events};
    next.squareFees = square.value.fees;
    next.status.square = 'ready';
    delete next.error.square;
  } else {
    if (next.status.square !== 'ready') next.status.square = 'error';
    next.error.square = message(square.reason, 'Could not read the chain');
  }
  if (ctg.status === 'fulfilled') {
    kept = {...kept, contagian: ctg.value.events};
    next.contagianPaid = ctg.value.paid;
    next.contagianSwaps = ctg.value.swaps;
    next.vaults = ctg.value.vaults;
    next.status.contagian = 'ready';
    delete next.error.contagian;
  } else {
    if (next.status.contagian !== 'ready') next.status.contagian = 'error';
    next.error.contagian = message(ctg.reason, 'Could not read the vaults');
  }
  if (square.status === 'fulfilled' || ctg.status === 'fulfilled') next.beat = snapshot.beat + 1;
  next.events = [...kept.square, ...kept.contagian].sort((a, b) => (a.block === b.block ? (a.id < b.id ? 1 : -1) : a.block < b.block ? 1 : -1)).slice(0, KEPT);
  snapshot = next;
  listeners.forEach(l => l());
}

let inflight: Promise<void> | null = null;
let lastStart = 0;
/**
 * Read the new blocks. Every component that shows activity calls this on its own timer; calls
 * that land while a read is running, or right after one, share it. So a page makes one read per
 * tick however many feeds and leaderboards are on it.
 */
export function pump(force = false): Promise<void> {
  if (inflight) return inflight;
  // measured from when the last read began: whichever component's timer comes round first sets the pace, the rest ride along
  if (!force && Date.now() - lastStart < ACTIVITY_TICK - 150) return Promise.resolve();
  lastStart = Date.now();
  inflight = read()
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The whole store, kept current while the component is mounted. */
export function useActivityStore(): Snapshot {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    void pump();
  }, []);
  useLive(() => pump(), ACTIVITY_TICK);
  return s;
}

/** Status of what a view asked for: one family, or either. */
export function statusOf(s: Snapshot, family?: Family): {status: Status; error?: string} {
  if (family) return {status: s.status[family], error: s.error[family]};
  if (s.status.square === 'ready' || s.status.contagian === 'ready') return {status: 'ready'};
  if (s.status.square === 'error' || s.status.contagian === 'error') return {status: 'error', error: s.error.square ?? s.error.contagian};
  return {status: 'loading'};
}

/**
 * The feed: every event on the site, or one token's, newest first. `beat` goes up on every
 * successful read, whether or not anything new arrived. `swaps` counts each Contagian token's trades.
 */
export function useActivity(o: {token?: string; family?: Family} = {}) {
  const s = useActivityStore();
  const token = o.token?.toLowerCase();
  const family = o.family;
  const events = useMemo(
    () => s.events.filter(e => (!token || e.token.toLowerCase() === token) && (!family || e.family === family)),
    [s.events, token, family],
  );
  return {events, beat: s.beat, swaps: s.contagianSwaps, ...statusOf(s, family), retry: () => void pump(true)};
}

/**
 * The ids of the big ones in a list: every gotchya, and a size in the top tenth of those priced
 * in the same quote. A list too short to have a top tenth has only its gotchyas.
 */
export function bigOnes(events: Activity[]): Set<string> {
  const byQuote = new Map<string, Activity[]>();
  for (const e of events) {
    if (e.worth === undefined || !e.quoteSymbol || !(e.worth > 0)) continue;
    byQuote.set(e.quoteSymbol, [...(byQuote.get(e.quoteSymbol) ?? []), e]);
  }
  const big = new Set<string>();
  // the wallet that just paid the Contagian tax is always the loud one
  for (const e of events) if (e.kind === 'gotchya') big.add(e.id);
  for (const list of byQuote.values()) {
    if (list.length < 10) continue;
    const sizes = list.map(e => e.worth!).sort((a, b) => a - b);
    const bar = sizes[Math.floor(sizes.length * 0.9)];
    for (const e of list) if (e.worth! >= bar) big.add(e.id);
  }
  return big;
}
