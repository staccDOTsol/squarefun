import {createPublicClient, defineChain, http, parseAbi, type Address} from 'viem';
import deployment from '../deployments/4663.json';

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
  rpcUrls: {default: {http: [import.meta.env.VITE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com']}},
  blockExplorers: {default: {name: 'Robinhood Explorer', url: 'https://robinhoodchain.blockscout.com'}},
});

export const publicClient = createPublicClient({chain: robinhood, transport: http(undefined, {batch: true})});

export const ADDR = deployment as {
  chainId: number;
  deployBlock: number;
  /** the pad's own token launch, pinned to the board hero (zero when none) */
  flagship?: Address;
  factory: Address;
  /** the $SQUARE staking pool (SquareStake) */
  sink: Address;
  /** the $SQUARE launch itself: the stake token */
  square: Address;
  /** first sink, still every launch's fee beneficiary; the pool drains it on sync */
  legacySink?: Address;
  /** plumbing token held entirely by the pool; never shown */
  placeholder?: Address;
  /** v2 pad: launches mint the two-ratchet token. Absent until deployed. */
  factoryV2?: Address;
  launchDeployerV2?: Address;
  deployBlockV2?: number;
  /** NativeSettler: every v2 launch's fee lands here in kind; anyone settles it into ETH */
  settler?: Address;
  squareVenue?: Address;
  /** WETH9 on Robinhood: the staked half arrives at the pool wrapped */
  weth?: Address;
  /** Launches through Uniswap's Liquidity Launcher (pools.xyz) with the Square token factory */
  pools?: {launcher: Address; instantStrategy: Address; tokenFactory: Address; settler: Address; venue: Address; deployBlock: number; tokens?: Address[]};
  /** MigrateFactory: the pooper scooper. Zero until deployed. */
  migrateFactory?: Address;
  /** ScoopBatch: a whole wallet in one transaction */
  scoopBatch?: Address;
  hook: Address;
  escrow: Address;
  vault: Address;
  locker: Address;
  executor: Address;
  launchDeployer: Address;
  poolManager: Address;
  positionManager: Address;
  permit2: Address;
  wizards: Address;
  owner: Address;
};

export const ZERO: Address = '0x0000000000000000000000000000000000000000';
export const DEAD: Address = '0x000000000000000000000000000000000000dEaD';

/** The site reads chain state only. Until the factory is on Robinhood, everything is empty. */
export const deployed = ADDR.factory !== ZERO;
/** Every factory whose launches the site shows, oldest first. */
export const FACTORIES: Address[] = [ADDR.factory, ...(ADDR.factoryV2 && ADDR.factoryV2 !== ZERO ? [ADDR.factoryV2] : [])];
/** Where new launches go: the newest factory. */
export const LAUNCH_FACTORY: Address = FACTORIES[FACTORIES.length - 1];

export const factoryAbi = parseAbi([
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
  'function getLaunchConfig(uint256 id) view returns ((uint256 supply, uint256 curveFeeBps, uint256 phantomQuote, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, bool enabled))',
  'function launchConfigCount() view returns (uint256)',
  'function launchFee() view returns (uint256)',
  'function launchEnabled() view returns (bool)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function launchToken((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)',
  'function graduate(address token)',
  'function createGraduatedPool(address token) returns (uint256 positionId)',
]);

export const curveAbi = parseAbi([
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
]);

export const tokenAbi = parseAbi([
  'event Reference(address indexed from, address indexed to, uint256 n, uint256 fee)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function referencesThisBlock() view returns (uint256)',
  'function referencesThisWindowBy(address origin) view returns (uint256)',
  'function slowFeeBps(uint256 n) view returns (uint256)',
  'function referenceFeeBps(uint256 n) view returns (uint256)',
  'function beneficiary() view returns (address)',
  'function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, (string twitter, string telegram, string discord, string website, string farcaster) tokenSocials)',
]);

export const sinkAbi = parseAbi([
  'event Synced(address indexed token, uint256 toWizards, uint256 toStakers)',
  'event Staked(address indexed who, uint256 amount)',
  'event Claimed(address indexed who, address indexed token, uint256 amount, uint256 through)',
  'function square() view returns (address)',
  'function wizardsBps() view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function staked(address) view returns (uint256)',
  'function distributionCount(address token) view returns (uint256)',
  'function distribution(address token, uint256 index) view returns ((uint64 blockNumber, uint192 amount, uint256 totalStakedBefore))',
  'function claimedThrough(address who, address token) view returns (uint256)',
  'function claimable(address who, address token) view returns (uint256)',
  'function reserved(address token) view returns (uint256)',
  'function sync(address token) returns (uint256 toWizards, uint256 toStakers)',
  'function stake(uint256 amount)',
  'function unstake(uint256 amount)',
  'function claim(address token, uint256 maxDistributions) returns (uint256)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
]);

/** Robinhood's public RPC caps eth_getLogs at roughly 50k blocks per call. */
export const LOG_CHUNK = 45_000n;

export async function getLogsChunked<T>(
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>,
  from: bigint,
  to: bigint,
): Promise<T[]> {
  const out: T[] = [];
  for (let a = from; a <= to; a += LOG_CHUNK + 1n) {
    const b = a + LOG_CHUNK > to ? to : a + LOG_CHUNK;
    out.push(...(await fetchRange(a, b)));
  }
  return out;
}

const tsCache = new Map<bigint, number>();
export async function blockTimestamp(n: bigint): Promise<number> {
  const hit = tsCache.get(n);
  if (hit) return hit;
  const b = await publicClient.getBlock({blockNumber: n});
  const ts = Number(b.timestamp) * 1000;
  tsCache.set(n, ts);
  return ts;
}

export const migrateAbi = parseAbi([
  'event Deposited(address indexed who, uint256 amount, uint256 credit, uint8 epoch)',
  'event Recovered(uint256 sold, uint256 quoteOut, uint256 remaining)',
  'event Converted(uint256 quoteIn, uint256 squareOut)',
  'event Claimed(address indexed who, uint256 amount)',
  'event Rescued(address indexed who, uint256 oldOut, uint256 quoteOut)',
  'function oldToken() view returns (address)',
  'function venue() view returns (address)',
  'function start() view returns (uint64)',
  'function epochLength() view returns (uint64)',
  'function epochs() view returns (uint8)',
  'function decayBps() view returns (uint16)',
  'function mandate() view returns (uint256)',
  'function sellCapBps() view returns (uint16)',
  'function cooldown() view returns (uint64)',
  'function recoverDeadline() view returns (uint64)',
  'function vestLength() view returns (uint64)',
  'function claimWindow() view returns (uint64)',
  'function totalDeposited() view returns (uint256)',
  'function totalCredits() view returns (uint256)',
  'function remaining() view returns (uint256)',
  'function recovered() view returns (uint256)',
  'function totalSquare() view returns (uint256)',
  'function lastSell() view returns (uint64)',
  'function claimStart() view returns (uint64)',
  'function converted() view returns (bool)',
  'function rescued() view returns (bool)',
  'function failed() view returns (bool)',
  'function depositsOpen() view returns (bool)',
  'function canRecover() view returns (bool)',
  'function epochAt(uint256 ts) view returns (uint8)',
  'function rateBps(uint8 epoch) view returns (uint256)',
  'function deposited(address) view returns (uint256)',
  'function credits(address) view returns (uint256)',
  'function claimed(address) view returns (uint256)',
  'function claimable(address) view returns (uint256)',
  'function rescuedBy(address) view returns (bool)',
  'function deposit(uint256 amount)',
  'function recover()',
  'function convert(uint256 minSquareOut)',
  'function claim() returns (uint256)',
  'function sweep()',
  'function rescue()',
]);

export const migrateFactoryAbi = parseAbi([
  'event MigrationCreated(address indexed migrate, address indexed oldToken, address indexed venue, address creator, uint256 index)',
  'function count() view returns (uint256)',
  'function all(uint256) view returns (address)',
  'function venueFor(address token) view returns (address)',
  'function venueCount() view returns (uint256)',
  'function venues(uint256) view returns (address)',
  'function byToken(address token) view returns (address[])',
  'function create(address token, (uint64 start, uint64 epochLength, uint8 epochs, uint16 decayBps, uint256 mandate, uint16 sellCapBps, uint64 cooldown, uint16 maxImpactBps, uint64 recoverWindow, uint64 vestLength, uint64 claimWindow) p) returns (address)',
]);
export const scooperDeployed = !!ADDR.migrateFactory && ADDR.migrateFactory !== ZERO;

export const scoopBatchAbi = parseAbi([
  'function preview(address[] tokens) view returns (bool[] ok, bool[] needsNew)',
  'function openFor(address token) view returns (address)',
  'function scoop(address[] tokens, uint256[] amounts, (uint64 start, uint64 epochLength, uint8 epochs, uint16 decayBps, uint256 mandate, uint16 sellCapBps, uint64 cooldown, uint16 maxImpactBps, uint64 recoverWindow, uint64 vestLength, uint64 claimWindow) terms) returns (address[])',
]);
export const batchDeployed = !!ADDR.scoopBatch && ADDR.scoopBatch !== ZERO;
/** dRPC wallet API, site-locked key. Empty when not configured. */
export const LAMBDA_URL: string = (import.meta.env.VITE_LAMBDA_URL as string | undefined) ?? '';

/** Stacc Wizards fee fanout: per-token accounting, harvest is permissionless, claim is per wizard NFT. */
export const wizardsAbi = parseAbi([
  'function harvest(address token)',
  'function claim(address token, uint256[] ids) returns (uint256)',
  'function reserved(address token) view returns (uint256)',
  'function pending(address token, uint256 id) view returns (uint256)',
  'function tokenCount() view returns (uint256)',
]);

export const settlerAbi = parseAbi([
  'event Settled(address indexed token, address indexed venue, uint256 sold, uint256 ethOut, uint256 burned, uint256 staked)',
  'function pending(address token) view returns (uint256)',
  'function venueFor(address token) view returns (address)',
  'function settle(address token, uint256 amount) returns (uint256 ethOut)',
]);
export const WETH: Address = (ADDR.weth ?? '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73') as Address;
