import type {Address} from 'viem';

export type Phase = 'curve' | 'swept' | 'pool' | 'rescued';

export interface Launch {
  token: Address;
  curve: Address;
  name: string;
  symbol: string;
  image: string;
  description: string;
  creator: Address;
  createdAt: number;
  createdBlock: bigint;
  phase: Phase;
  /** ETH actually raised on the curve */
  quoteReserve: number;
  /** ETH needed to graduate */
  graduationThreshold: number;
  /** ETH per whole token, from the curve's virtual reserves */
  priceEth: number;
  /** priceEth × total supply */
  marketCapEth: number;
  /** IERC12384 references counted in the current block */
  referencesThisBlock: number;
  /** total reference fees this token has paid, in tokens (sealed sink balance × 2) */
  squarePaid: number;
  /** curve trades seen in the scanned window */
  tradeCount: number;
  /**
   * 'pools': launched through Uniswap's Liquidity Launcher, straight into a v4 pool, no curve.
   * 'contagian': a Contagian token, in a v4 pool against its memequote; see `contagian` below.
   */
  kind?: 'pad' | 'pools' | 'contagian';
  /**
   * Contagian tokens are priced in their memequote, not in ETH, and measured against parity (one
   * of the peg per token). `priceEth` and `marketCapEth` are zero unless the memequote is ETH.
   */
  contagian?: {quoteSymbol: string; pegSymbol: string; price: number | null; parityPct: number | null};
  /** Pools launches: the weekly allowance this token's rule gives each wallet (16 in the first version, 6 after) */
  slowFree?: number;
  /** ETH this token's moon jar has forwarded plus what its held fees quote at (moon drops only) */
  moonJarEth?: number;
  /** a flat fee on every buy out of the pool, on top of nothing (the higher of it and the ratchet applies); sells never pay it */
  buyFeeBps?: number;
  /** which factory launched it */
  factory: Address;
  /** v2 tokens carry two ratchets: first two references in a block are free */
  twoRatchets: boolean;
  socials: {twitter?: string; telegram?: string; discord?: string; website?: string; farcaster?: string};
}

export interface Trade {
  ts: number;
  block: bigint;
  side: 'buy' | 'sell';
  quote: number;
  tokens: number;
  price: number;
  fee: number;
  who: Address;
  tx: `0x${string}`;
}

export interface Reference {
  ts: number;
  block: bigint;
  from: Address;
  to: Address;
  n: number;
  fee: number;
  tx: `0x${string}`;
}

export interface Distribution {
  token: Address;
  symbol: string;
  index: number;
  block: number;
  amount: number;
  totalStakedBefore: number;
}

export interface SinkState {
  totalStaked: number;
  wizardsBps: number;
  yourStake: number;
  yourWallet: number;
  tokens: Array<{token: Address; symbol: string; distributions: Distribution[]; claimable: number; pending: number; wizardsUnharvested: number; settlerPending: number}>;
}

export interface LaunchConfig {
  supply: number;
  curveFeeBps: number;
  phantomQuote: number;
  graduationThreshold: number;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
  launchFee: number;
  maxCreatorTaxBps: number;
}

export type Sort = 'activity' | 'created' | 'marketCap' | 'progress' | 'square';
export type Feed = 'all' | 'curve' | 'graduated';

export type MigrationStage = 'deposits' | 'waiting' | 'recovering' | 'convert' | 'claims' | 'failed' | 'done';

export interface Migration {
  address: Address;
  oldToken: Address;
  oldSymbol: string;
  oldName: string;
  venue: Address;
  start: number;
  epochLength: number;
  epochs: number;
  decayBps: number;
  mandate: number;
  sellCapBps: number;
  cooldown: number;
  recoverDeadline: number;
  vestLength: number;
  claimWindow: number;
  totalDeposited: number;
  totalCredits: number;
  remaining: number;
  recovered: number;
  totalSquare: number;
  lastSell: number;
  claimStart: number;
  converted: boolean;
  rescued: boolean;
  failed: boolean;
  depositsOpen: boolean;
  canRecover: boolean;
  epochNow: number;
  rateNowBps: number;
  stage: MigrationStage;
  you: {deposited: number; credits: number; claimed: number; claimable: number; rescued: boolean; oldBalance: number; oldAllowance: number} | null;
  depositors: number;
}

export interface WalletToken {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  /** raw balance */
  raw: bigint;
  amount: number;
  usd: number;
  /** the scooper can sell it */
  ok: boolean;
  /** no open takeover yet: scooping creates one */
  needsNew: boolean;
}
