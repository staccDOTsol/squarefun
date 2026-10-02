import {encodeAbiParameters, getAddress, isAddress, keccak256, parseAbi, parseEventLogs, type Address, type WalletClient} from 'viem';
import {ADDR, ZERO, publicClient, robinhood} from './chain';

/**
 * Contagian: a token standard, not one token. A memecoin that tends to its peg. A launch names a
 * memequote (what the token trades against, and what everything it pays out is paid in) and a peg
 * (what it is trying to be worth one of). Parity is one of the peg per token, in the memequote, and
 * it follows the peg's price. Over parity buyers pay and sellers do not; under it sellers pay and
 * buyers do not. Each token has its own vault, a clone, which measures the token, holds its tolls,
 * sells them on the way up and never down, and pays what they sell for to the bad beats (the
 * wallets that paid the tax) and to holders.
 */

export const LAUNCHER = ADDR.contagian?.launcher;
/** The launcher address is filled in after deployment; until then the page reads nothing. */
export const contagianDeployed = !!LAUNCHER && LAUNCHER !== ZERO;

export const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
/** Uniswap v4 StateView on Robinhood: pool reads without going through the manager's storage. */
const STATE_VIEW: Address = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
/** Hookless fee/spacing pairs probed for a pool between a peg and a memequote. */
const REF_POOLS = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
] as const;
const TICK_SPACING = 25;
/** The widest tick aligned to the spacing; the strategy refuses anything outside it. */
const EDGE_TICK = 887_250;
const LN_TICK = Math.log(1.0001);
/** Parity over the opening price that opens a 1B supply at about a Pools instant launch's market cap. */
export const DEFAULT_MULTIPLE = 145_000;
/** The vault's `DRIP`, in seconds, for copy shown before any vault exists to ask. Every vault is asked for its own. */
export const DEFAULT_DRIP = 3600;

/** A span of seconds in words: "an hour", "a week", "36 hours". */
export function span(seconds: number): string {
  const units: Array<[number, string]> = [
    [604_800, 'week'],
    [86_400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return n === 1 ? `${name === 'hour' ? 'an' : 'a'} ${name}` : `${n} ${name}s`;
    }
  }
  return `${seconds} seconds`;
}
export const CONTAGIAN_SUPPLY = 1_000_000_000;

export const launcherAbi = parseAbi([
  'event Launched(address indexed token, address indexed vault, address indexed creator, address quote, address peg, int24 openTick, int24 ceilingTick)',
  'function launch((string name, string symbol, (string description, string website, string image, uint256 xProofTweetId) metadata, address quote, (address asset, uint24 refFee, int24 refSpacing) peg, int24 openTick, int24 ceilingTick, (address asset, uint24 refFee, int24 refSpacing)[] partners) p) returns (address token, address vault)',
  'function count() view returns (uint256)',
  'function launches(uint256 index) view returns (address token, address vault, address creator, address quote, address peg, int24 openTick, int24 ceilingTick, uint64 launchedAt)',
  'function launchOf(address token) view returns ((address token, address vault, address creator, address quote, address peg, int24 openTick, int24 ceilingTick, uint64 launchedAt))',
]);

/**
 * The vault's events the site reads. `Gotchya` is left out on purpose: it carries the same wallet
 * and amounts as the `Paid` beside it plus the whole note, and the note is one constant (`GOTCHYA()`).
 */
export const vaultEventAbi = parseAbi([
  'event Paid(address indexed originator, uint256 tolls, uint256 worth)',
  'event Settled(address indexed caller, uint256 tolls, uint256 quoteIn, uint256 tip)',
  'event Offered(address indexed other, uint256 tolls, int24 lower, int24 upper)',
  'event Harvested(address indexed other, uint256 tokens, uint256 otherAmount, bool sold)',
  'event Reflected(uint256 toPayers, uint256 toHolders)',
  'event Yield(uint256 toWizards, uint256 toStakers, uint256 toPayers)',
  'event Claimed(address indexed who, uint256 amount)',
]);

export const vaultAbi = parseAbi([
  'event Gotchya(address indexed to, uint256 tolls, uint256 worth, string message)',
  'function spot() view returns (uint256)',
  'function parity() view returns (uint256)',
  'function peg() view returns (address asset, uint24 refFee, int24 refSpacing)',
  'function tolls() view returns (uint256)',
  'function taxBps() view returns (uint256 buyBps, uint256 sellBps)',
  'function partnerCount() view returns (uint256)',
  'function rangeCount() view returns (uint256)',
  'function paidBy(address who) view returns (uint256)',
  'function pendingBy(address who) view returns (uint256)',
  'function maturesAt(address who) view returns (uint256)',
  'function totalPaid() view returns (uint256)',
  'function DRIP() view returns (uint256)',
  'function GOTCHYA() view returns (string)',
  'function shareBps(address who) view returns (uint256)',
  'function claimable(address who) view returns (uint256 asPayer, uint256 asHolder)',
  'function claim() returns (uint256 amount)',
  'function activate(address who)',
  'function offer() returns (uint256 placed)',
  'function settle() returns (uint256 sold, uint256 quoteIn)',
  'function deepen(uint256 i) returns (uint256 placed)',
  'function harvest(uint256 from, uint256 n) returns (uint256 proceeds, uint256 fees)',
]);

const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
]);

const metaAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

export type Asset = {address: Address; symbol: string; decimals: number};
export const ETH_ASSET: Asset = {address: ZERO, symbol: 'ETH', decimals: 18};
export const USDG_ASSET: Asset = {address: USDG, symbol: 'USDG', decimals: 6};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A pasted address, checksummed; null when it is not one. */
export const toAddress = (s: string): Address | null => (isAddress(s.trim(), {strict: false}) ? getAddress(s.trim()) : null);

const assets = new Map<string, Promise<Asset>>();
/** Symbol and decimals of a memequote or peg. Native ETH is the zero address. */
export function assetOf(address: Address): Promise<Asset> {
  if (same(address, ZERO)) return Promise.resolve(ETH_ASSET);
  if (same(address, USDG)) return Promise.resolve(USDG_ASSET);
  const k = address.toLowerCase();
  let hit = assets.get(k);
  if (!hit) {
    hit = Promise.all([
      publicClient.readContract({address, abi: metaAbi, functionName: 'symbol'}),
      publicClient.readContract({address, abi: metaAbi, functionName: 'decimals'}),
    ]).then(([symbol, decimals]) => ({address, symbol, decimals}));
    hit.catch(() => assets.delete(k));
    assets.set(k, hit);
  }
  return hit;
}

type Ref = {fee: number; spacing: number};

/**
 * One whole peg in whole memequote, and the hookless v4 pool it was read from: the one between
 * the two with the most liquidity. The vault prices parity from that same pool for good. Null
 * when no such pool exists.
 */
async function pegPrice(peg: Asset, quote: Asset): Promise<{price: number; ref: Ref} | null> {
  if (same(peg.address, quote.address)) return {price: 1, ref: {fee: 0, spacing: 0}};
  const pegIs0 = peg.address.toLowerCase() < quote.address.toLowerCase();
  const [c0, c1] = pegIs0 ? [peg.address, quote.address] : [quote.address, peg.address];
  const pools = await Promise.all(
    REF_POOLS.map(async ([fee, spacing]) => {
      const id = keccak256(
        encodeAbiParameters(
          [{type: 'address'}, {type: 'address'}, {type: 'uint24'}, {type: 'int24'}, {type: 'address'}],
          [c0, c1, fee, spacing, ZERO],
        ),
      );
      const [slot0, liquidity] = await Promise.all([
        publicClient.readContract({address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [id]}),
        publicClient.readContract({address: STATE_VIEW, abi: stateViewAbi, functionName: 'getLiquidity', args: [id]}),
      ]);
      return {sqrtP: slot0[0], liquidity, fee, spacing};
    }),
  );
  const best = pools.filter(p => p.sqrtP > 0n && p.liquidity > 0n).sort((a, b) => (a.liquidity > b.liquidity ? -1 : a.liquidity < b.liquidity ? 1 : 0))[0];
  if (!best) return null;
  const root = Number(best.sqrtP) / 2 ** 96;
  // the pool's own price is raw currency1 per raw currency0
  const ratio = root * root;
  const rawQuotePerPeg = pegIs0 ? ratio : 1 / ratio;
  return {price: rawQuotePerPeg * 10 ** (peg.decimals - quote.decimals), ref: {fee: best.fee, spacing: best.spacing}};
}

export type Pair = {
  quote: Asset;
  peg: Asset;
  /** one whole peg, in whole memequote, now */
  pegInQuote: number;
  /** the pool that prices the peg in the memequote; fee and spacing zero when the peg is the memequote */
  ref: Ref;
};

/** Read both assets and the rate between them. Throws in plain words when either cannot be read or priced. */
export async function resolvePair(quote: Address, peg: Address): Promise<Pair> {
  const [q, p] = await Promise.all([
    assetOf(quote).catch(() => {
      throw new Error('Could not read the memequote: is that a token on this chain?');
    }),
    assetOf(peg).catch(() => {
      throw new Error('Could not read the peg: is that a token on this chain?');
    }),
  ]);
  const found = await pegPrice(p, q);
  if (!found || !(found.price > 0) || !Number.isFinite(found.price)) {
    throw new Error(`There is no Uniswap v4 pool between ${p.symbol} and ${q.symbol}, so parity cannot be priced.`);
  }
  return {quote: q, peg: p, pegInQuote: found.price, ref: found.ref};
}

const round25 = (x: number) => Math.round(x / TICK_SPACING) * TICK_SPACING || 0;
/** Whole memequote per whole token at a tick. Ticks are raw quote units per raw token unit; the token has 18 decimals. */
export const tickPrice = (tick: number, quoteDecimals: number) => Math.pow(1.0001, tick) * 10 ** (18 - quoteDecimals);

export type Terms = {
  openTick: number;
  /** the top of the range the supply sits in: the widest tick. Parity is wherever the peg puts it, inside the range */
  ceilingTick: number;
  openPrice: number;
  /** parity now, in whole memequote per token: one of the peg */
  parityPrice: number;
};

/**
 * The two ticks a launch names: the opening, `multiple` times under parity as it stands today,
 * and the top of the range the supply runs to. Null when the opening does not fit.
 */
export function termsFor(pair: Pair, multiple: number): Terms | null {
  if (!(multiple > 1) || !Number.isFinite(multiple)) return null;
  const rawParity = (pair.pegInQuote * 10 ** pair.quote.decimals) / 1e18;
  const openTick = round25(Math.log(rawParity) / LN_TICK) - round25(Math.log(multiple) / LN_TICK);
  if (!(openTick < EDGE_TICK) || openTick < -EDGE_TICK) return null;
  return {openTick, ceilingTick: EDGE_TICK, openPrice: tickPrice(openTick, pair.quote.decimals), parityPrice: pair.pegInQuote};
}

export type Partner = {asset: Address; refFee: number; refSpacing: number};
/** What unsold tolls are also offered against: the other of ETH and USDG, priced by their 0.01% pool. */
export function defaultPartners(quote: Address): Partner[] {
  if (same(quote, USDG)) return [{asset: ZERO, refFee: 100, refSpacing: 1}];
  if (same(quote, ZERO)) return [{asset: USDG, refFee: 100, refSpacing: 1}];
  return [];
}

export type ContagianLaunch = {
  token: Address;
  vault: Address;
  creator: Address;
  name: string;
  symbol: string;
  quote: Asset;
  peg: Asset;
  openTick: number;
  ceilingTick: number;
  /** ms */
  launchedAt: number;
  /** the vault's window, in seconds: how long an entry waits before it earns, and how long a payout takes to be released */
  drip: number;
  /** whole memequote per whole token; null when the vault could not be read */
  spot: number | null;
  /** parity now: one of the peg per token, in whole memequote. It follows the peg's price */
  parity: number | null;
  /** the lagging tax each side would pay now, in basis points */
  buyBps: number | null;
  sellBps: number | null;
  /** tokens the vault holds */
  tolls: number | null;
};

type Row = {token: Address; vault: Address; creator: Address; quote: Address; peg: Address; openTick: number; ceilingTick: number; launchedAt: bigint};

const fixedFacts = new Map<string, Promise<{name: string; symbol: string; drip: number; gotchya: string}>>();
/** What a launch fixed for good: its name and ticker, the vault's window, and the note it sends whoever pays the tax. Read once per page view. */
function fixed(r: Pick<Row, 'token' | 'vault'>) {
  const k = r.token.toLowerCase();
  let hit = fixedFacts.get(k);
  if (!hit) {
    hit = Promise.all([
      publicClient.readContract({address: r.token, abi: metaAbi, functionName: 'name'}),
      publicClient.readContract({address: r.token, abi: metaAbi, functionName: 'symbol'}),
      publicClient.readContract({address: r.vault, abi: vaultAbi, functionName: 'DRIP'}).then(Number).catch(() => DEFAULT_DRIP),
      publicClient.readContract({address: r.vault, abi: vaultAbi, functionName: 'GOTCHYA'}).catch(() => ''),
    ]).then(([name, symbol, drip, gotchya]) => ({name, symbol, drip, gotchya}));
    hit.catch(() => fixedFacts.delete(k));
    fixedFacts.set(k, hit);
  }
  return hit;
}

/** Each launch's record at the launcher, by token (lowercase): it never changes, so it is asked for once. */
const rows = new Map<string, Row>();

async function hydrate(r: Row): Promise<ContagianLaunch> {
  rows.set(r.token.toLowerCase(), r);
  const read = <F extends 'spot' | 'parity' | 'tolls' | 'taxBps'>(functionName: F) => publicClient.readContract({address: r.vault, abi: vaultAbi, functionName});
  const [{name, symbol, drip}, quote, peg, stats] = await Promise.all([
    fixed(r),
    assetOf(r.quote),
    assetOf(r.peg).catch(() => ({address: r.peg, symbol: `${r.peg.slice(0, 6)}…`, decimals: 18})),
    // a vault that cannot be read must not take the token off the list
    Promise.all([read('spot'), read('parity'), read('tolls'), read('taxBps')]).catch(() => null),
  ]);
  // prices are raw quote units per raw token unit, times 1e36
  const whole = (x: bigint) => (Number(x) / 1e36) * 10 ** (18 - quote.decimals);
  return {
    token: r.token,
    vault: r.vault,
    creator: r.creator,
    name,
    symbol,
    quote,
    peg,
    openTick: r.openTick,
    ceilingTick: r.ceilingTick,
    launchedAt: Number(r.launchedAt) * 1000,
    drip,
    spot: stats ? whole(stats[0]) : null,
    parity: stats ? whole(stats[1]) : null,
    tolls: stats ? Number(stats[2]) / 1e18 : null,
    buyBps: stats ? Number(stats[3][0]) : null,
    sellBps: stats ? Number(stats[3][1]) : null,
  };
}

export type ContagianDetail = ContagianLaunch & {
  partnerCount: number;
  rangeCount: number;
  /** tax paid by entries that are earning, in the memequote; zero means the bad beats' half goes to holders for now */
  totalPaid: number;
  /** the note the vault sends a wallet every time it pays the tax: the contract's own `GOTCHYA()` */
  gotchya: string;
};
/** A wallet's entry in the vault's directory of who paid the tax. Amounts are in the memequote. */
export type ContagianWallet = {
  /** share of everything that is earning, in basis points */
  shareBps: number;
  /** tax paid that is earning */
  earning: number;
  /** tax paid that is not earning yet */
  waiting: number;
  /** when the waiting part starts earning, ms; paying again before then starts the wait again */
  maturesAt: number;
  /** what could be claimed now as a bad beat (with anything settled earlier and not collected) */
  asPayer: number;
  /** what could be claimed now as a holder */
  asHolder: number;
  /** when these were read, ms */
  readAt: number;
};

export const contagian = {
  /** Launches, newest first, at most `cap`. */
  async list(cap = 50): Promise<ContagianLaunch[]> {
    if (!contagianDeployed) return [];
    const count = Number(await publicClient.readContract({address: LAUNCHER!, abi: launcherAbi, functionName: 'count'}));
    const indexes = Array.from({length: Math.min(count, cap)}, (_, i) => BigInt(count - 1 - i));
    return Promise.all(
      indexes.map(async i => {
        const [token, vault, creator, quote, peg, openTick, ceilingTick, launchedAt] = await publicClient.readContract({
          address: LAUNCHER!,
          abi: launcherAbi,
          functionName: 'launches',
          args: [i],
        });
        return hydrate({token, vault, creator, quote, peg, openTick, ceilingTick, launchedAt});
      }),
    );
  },

  /**
   * One launch by its token, with its live numbers. Null for a token this launcher did not make
   * (the read reverts). The launcher is asked which launch it is once; after that only the vault is read.
   */
  async one(token: Address): Promise<ContagianDetail | null> {
    if (!contagianDeployed) return null;
    const row =
      rows.get(token.toLowerCase()) ?? (await publicClient.readContract({address: LAUNCHER!, abi: launcherAbi, functionName: 'launchOf', args: [token]}).catch(() => null));
    if (!row) return null;
    const [l, {gotchya}, partnerCount, rangeCount, totalPaid] = await Promise.all([
      hydrate(row),
      fixed(row),
      publicClient.readContract({address: row.vault, abi: vaultAbi, functionName: 'partnerCount'}),
      publicClient.readContract({address: row.vault, abi: vaultAbi, functionName: 'rangeCount'}),
      publicClient.readContract({address: row.vault, abi: vaultAbi, functionName: 'totalPaid'}),
    ]);
    return {...l, partnerCount: Number(partnerCount), rangeCount: Number(rangeCount), totalPaid: Number(totalPaid) / 10 ** l.quote.decimals, gotchya};
  },

  /** A wallet's place in the vault's directory of who paid the tax. */
  async wallet(l: Pick<ContagianLaunch, 'vault' | 'quote'>, who: Address): Promise<ContagianWallet> {
    const at = {address: l.vault, abi: vaultAbi} as const;
    const [shareBps, paid, waiting, maturesAt, claimable] = await Promise.all([
      publicClient.readContract({...at, functionName: 'shareBps', args: [who]}),
      publicClient.readContract({...at, functionName: 'paidBy', args: [who]}),
      publicClient.readContract({...at, functionName: 'pendingBy', args: [who]}),
      publicClient.readContract({...at, functionName: 'maturesAt', args: [who]}),
      publicClient.readContract({...at, functionName: 'claimable', args: [who]}),
    ]);
    const unit = 10 ** l.quote.decimals;
    return {
      shareBps: Number(shareBps),
      earning: Number(paid) / unit,
      waiting: Number(waiting) / unit,
      maturesAt: Number(maturesAt) * 1000,
      asPayer: Number(claimable[0]) / unit,
      asHolder: Number(claimable[1]) / unit,
      readAt: Date.now(),
    };
  },

  /** The part of each wallet's tax that is earning, summed over `vaults` (which share a memequote). One read a wallet a vault. */
  async earning(vaults: Array<Pick<ContagianLaunch, 'vault' | 'quote'>>, who: Address[]): Promise<Record<string, number>> {
    const sums: Record<string, number> = {};
    await Promise.all(
      vaults.flatMap(v =>
        who.map(async w => {
          const paid = await publicClient.readContract({address: v.vault, abi: vaultAbi, functionName: 'paidBy', args: [w]});
          sums[w.toLowerCase()] = (sums[w.toLowerCase()] ?? 0) + Number(paid) / 10 ** v.quote.decimals;
        }),
      ),
    );
    return sums;
  },

  /** What the directory holds for each of `who`: the earning part, its share, and what it could claim (as a bad beat and as a holder together). Three reads a wallet. */
  async standings(l: Pick<ContagianLaunch, 'vault' | 'quote'>, who: Address[]): Promise<Record<string, {earning: number; shareBps: number; claimable: number}>> {
    const unit = 10 ** l.quote.decimals;
    const rows = await Promise.all(
      who.map(async w => {
        const [paid, shareBps, claimable] = await Promise.all([
          publicClient.readContract({address: l.vault, abi: vaultAbi, functionName: 'paidBy', args: [w]}),
          publicClient.readContract({address: l.vault, abi: vaultAbi, functionName: 'shareBps', args: [w]}),
          publicClient.readContract({address: l.vault, abi: vaultAbi, functionName: 'claimable', args: [w]}),
        ]);
        return [w.toLowerCase(), {earning: Number(paid) / unit, shareBps: Number(shareBps), claimable: Number(claimable[0] + claimable[1]) / unit}] as const;
      }),
    );
    return Object.fromEntries(rows);
  },
};

export const contagianTx = {
  /** One transaction: a vault, the token, and the whole supply in one position. Moves no memequote, so it carries no value. */
  async launch(
    w: WalletClient,
    account: Address,
    p: {name: string; symbol: string; description: string; image: string; quote: Address; peg: Partner; openTick: number; ceilingTick: number},
  ) {
    const hash = await w.writeContract({
      chain: robinhood,
      account,
      address: LAUNCHER!,
      abi: launcherAbi,
      functionName: 'launch',
      args: [
        {
          name: p.name,
          symbol: p.symbol,
          metadata: {description: p.description, website: 'https://squarefun.xyz', image: p.image, xProofTweetId: 0n},
          quote: p.quote,
          peg: p.peg,
          openTick: p.openTick,
          ceilingTick: p.ceilingTick,
          partners: defaultPartners(p.quote),
        },
      ],
    });
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    if (receipt.status !== 'success') throw new Error('Launch reverted');
    const log = parseEventLogs({abi: launcherAbi, eventName: 'Launched', logs: receipt.logs}).find(l => same(l.address, LAUNCHER!));
    return {hash, token: log?.args.token, vault: log?.args.vault};
  },

  async claim(w: WalletClient, account: Address, vault: Address) {
    const hash = await w.writeContract({chain: robinhood, account, address: vault, abi: vaultAbi, functionName: 'claim'});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  /** Anyone may start a matured entry earning; the page offers it for the connected wallet's own. */
  async activate(w: WalletClient, account: Address, vault: Address, who: Address) {
    const hash = await w.writeContract({chain: robinhood, account, address: vault, abi: vaultAbi, functionName: 'activate', args: [who]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  async offer(w: WalletClient, account: Address, vault: Address) {
    const hash = await w.writeContract({chain: robinhood, account, address: vault, abi: vaultAbi, functionName: 'offer'});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  async settle(w: WalletClient, account: Address, vault: Address) {
    const hash = await w.writeContract({chain: robinhood, account, address: vault, abi: vaultAbi, functionName: 'settle'});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  /** The first partner only: launches from this site name at most one. */
  async deepen(w: WalletClient, account: Address, vault: Address) {
    const hash = await w.writeContract({chain: robinhood, account, address: vault, abi: vaultAbi, functionName: 'deepen', args: [0n]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  /** Every range the vault has tolls on offer in, as counted now. */
  async harvest(w: WalletClient, account: Address, vault: Address) {
    const n = await publicClient.readContract({address: vault, abi: vaultAbi, functionName: 'rangeCount'});
    const hash = await w.writeContract({chain: robinhood, account, address: vault, abi: vaultAbi, functionName: 'harvest', args: [0n, n]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },
};
