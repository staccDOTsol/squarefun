import {
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  keccak256,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem';
import {ADDR, ZERO, blockTimestamp, erc20Abi, getLogsChunked, logTimestamp, once, publicClient, robinhood, scan} from './chain';
import type {Launch, Reference, Trade} from './types';

/**
 * Launches made through Uniswap's Liquidity Launcher (pools.xyz) with the Square token factory.
 * The whole supply sits in one hookless native-ETH Uniswap v4 pool from the first block, so
 * there is no curve: price, trades and quotes all come from that pool.
 */

const P = ADDR.pools;
export const poolsDeployed = !!P && P.tokenFactory !== ZERO;
/** Every Square token factory whose launches the site shows, oldest first. */
const TOKEN_FACTORIES: Address[] = P ? [P.tokenFactory, ...(P.tokenFactoryV2 && P.tokenFactoryV2 !== ZERO ? [P.tokenFactoryV2] : [])] : [];
/** Where new launches go: the newest factory. The second version prices every third transfer in a block and allows six trades a week. */
const LAUNCH_TOKEN_FACTORY: Address | undefined = TOKEN_FACTORIES[TOKEN_FACTORIES.length - 1];
/** Whether new launches get the second version of the rule. */
export const launchesV2 = TOKEN_FACTORIES.length > 1;
/** Factories whose launches are listed but never launched through: the moon drop's one-token factory. */
const LISTED_FACTORIES: Address[] = [...TOKEN_FACTORIES, ...(P?.moonFactory && P.moonFactory !== ZERO ? [P.moonFactory] : [])];
const jarAbi = parseAbi(['function forwarded() view returns (uint256)']);
const buyFeeAbi = parseAbi(['function buyFeeBps() view returns (uint256)']);
/** A token's buy fee in bp, 0 when it has none (every Square token but the moon drop). */
const buyFee = (token: Address) =>
  publicClient.readContract({address: token, abi: buyFeeAbi, functionName: 'buyFeeBps'}).then(Number).catch(() => 0);

const UNIVERSAL_ROUTER: Address = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
const QUOTER: Address = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
const LP_FEE = 2500;
const TICK_SPACING = 25;
export const POOLS_SUPPLY = 1_000_000_000n * 10n ** 18n;

const f = (x: bigint) => Number(formatEther(x));
const wei = (x: number) => parseEther(Math.max(0, x).toFixed(18));

const metadataType = {
  type: 'tuple',
  components: [
    {name: 'description', type: 'string'},
    {name: 'website', type: 'string'},
    {name: 'image', type: 'string'},
    {name: 'xProofTweetId', type: 'uint256'},
  ],
} as const;

const factoryAbi = parseAbi([
  'event TokenCreated(address tokenAddress, (string description, string website, string image, uint256 xProofTweetId) metadata)',
  'function getTokenAddress(string name, string symbol, uint256 initialSupply, address recipient, bytes data, address creator, bytes32 graffiti) view returns (address)',
]);
const tokenAbi = parseAbi([
  'event Reference(address indexed from, address indexed to, uint256 n, uint256 fee)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function referencesThisBlock() view returns (uint256)',
  'function metadata() view returns (string description, string website, string image, uint256 xProofTweetId)',
  'function birthBlock() view returns (uint64)',
  'function SLOW_FREE() view returns (uint256)',
]);
const launcherAbi = parseAbi([
  'function createToken(address factory, string name, string symbol, uint8 decimals, uint128 initialSupply, address recipient, bytes tokenData) returns (address)',
  'function distributeToken(address token, (address strategy, uint128 amount, bytes configData) distribution, bytes32 salt)',
  'function multicall(bytes[] data) returns (bytes[])',
  'function getGraffiti(address originalCreator) pure returns (bytes32)',
]);
const venueAbi = parseAbi(['function spot(address token) view returns (uint256)']);
const managerAbi = parseAbi([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

const keyFor = (token: Address) => ({currency0: ZERO, currency1: token, fee: LP_FEE, tickSpacing: TICK_SPACING, hooks: ZERO});
const poolId = (token: Address): Hex =>
  keccak256(
    encodeAbiParameters(
      [{type: 'address'}, {type: 'address'}, {type: 'uint24'}, {type: 'int24'}, {type: 'address'}],
      [ZERO, token, LP_FEE, TICK_SPACING, ZERO],
    ),
  );

/** Tokens known to be Pools launches, lowercase. Filled as launches are read. */
const known = new Set<string>();
export const isPoolsToken = (a: Address) => known.has(a.toLowerCase());

type Created = {token: Address; block: bigint; factory: Address; tx: Hex; ts: number};
type Index = {created: Created[]; swaps: Record<string, number> | null; fees: Record<string, bigint> | null};

/**
 * Every Pools launch, with each one's swap count and the reference fees it has paid since its launch.
 * Three scans whatever the number of tokens, each remembered: after the first read only new blocks
 * are fetched. All three run to the same block, so a token is always listed before its logs are counted.
 */
/** Every Pools launch, oldest first: one remembered scan. */
async function createdUpTo(to: bigint): Promise<Created[]> {
  if (!poolsDeployed) return [];
  const created = await scan({
    key: `pools-created:${LISTED_FACTORIES.join()}`,
    read: (a, b) => publicClient.getLogs({address: LISTED_FACTORIES, event: factoryAbi[0], fromBlock: a, toBlock: b}),
    addresses: LISTED_FACTORIES.length,
    from: BigInt(P!.deployBlock),
    to,
    init: [] as Created[],
    fold: (acc, logs) => [
      ...acc,
      ...logs.map(l => ({token: l.args.tokenAddress!, block: l.blockNumber, factory: l.address as Address, tx: l.transactionHash, ts: Number(l.blockTimestamp ?? 0n) * 1000})),
    ],
  });
  for (const c of created) known.add(c.token.toLowerCase());
  return created;
}

async function index(to: bigint): Promise<Index> {
  if (!poolsDeployed) return {created: [], swaps: {}, fees: {}};
  const created = await createdUpTo(to);
  if (created.length === 0) return {created, swaps: {}, fees: {}};
  const tokens = created.map(c => c.token);
  const ids = tokens.map(poolId);
  const from = created[0].block;
  // a failed count must not take the token off the board
  const [swaps, fees] = await Promise.all([
    scan({
      key: 'pools-swaps',
      read: (a, b) => publicClient.getLogs({address: ADDR.poolManager, event: managerAbi[0], args: {id: ids}, fromBlock: a, toBlock: b}),
      from,
      to,
      init: {} as Record<string, number>,
      fold: (acc, logs) => {
        const next = {...acc};
        for (const l of logs) next[l.args.id!] = (next[l.args.id!] ?? 0) + 1;
        return next;
      },
    }).catch(() => null),
    scan({
      key: 'pools-fees',
      read: (a, b) => publicClient.getLogs({address: tokens, event: tokenAbi[0], fromBlock: a, toBlock: b}),
      addresses: tokens.length,
      from,
      to,
      init: {} as Record<string, bigint>,
      fold: (acc, logs) => {
        const next = {...acc};
        // log.address is lowercase from the RPC
        for (const l of logs) next[l.address.toLowerCase()] = (next[l.address.toLowerCase()] ?? 0n) + (l.args.fee ?? 0n);
        return next;
      },
    }).catch(() => null),
  ]);
  return {created, swaps, fees};
}

async function swapLogs(token: Address, from: bigint, to: bigint) {
  return getLogsChunked(
    (a, b) => publicClient.getLogs({address: ADDR.poolManager, event: managerAbi[0], args: {id: poolId(token)}, fromBlock: a, toBlock: b}),
    from,
    to,
  );
}

const statics = new Map<string, Promise<{name: string; symbol: string; meta: readonly [string, string, string, bigint]; slowFree: bigint; buyFeeBps: number}>>();
/** What a token fixed at launch: read once per page view. */
function fixed(token: Address) {
  const k = token.toLowerCase();
  let hit = statics.get(k);
  if (!hit) {
    const hero = ADDR.hero?.token.toLowerCase() === k;
    hit = Promise.all([
      publicClient.readContract({address: token, abi: tokenAbi, functionName: 'name'}),
      publicClient.readContract({address: token, abi: tokenAbi, functionName: 'symbol'}),
      publicClient.readContract({address: token, abi: tokenAbi, functionName: 'metadata'}),
      publicClient.readContract({address: token, abi: tokenAbi, functionName: 'SLOW_FREE'}).catch(() => 16n),
      hero ? buyFee(token) : Promise.resolve(0),
    ]).then(([name, symbol, meta, slowFree, buyFeeBps]) => ({name, symbol, meta, slowFree, buyFeeBps}));
    hit.catch(() => statics.delete(k));
    statics.set(k, hit);
  }
  return hit;
}

/** The sender of the launch transaction: the token only knows the launcher. */
const creatorOf = (c: Created) => once(`sender:${c.tx}`, async () => (await publicClient.getTransaction({hash: c.tx})).from);

async function hydrate(c: {token: Address; block: bigint; factory: Address; creator: Address; createdAt: number}, tradeCount: number, squarePaid: number): Promise<Launch> {
  const {token} = c;
  known.add(token.toLowerCase());
  const hero = ADDR.hero && ADDR.hero.token.toLowerCase() === token.toLowerCase() ? ADDR.hero : null;
  const [{name, symbol, meta, slowFree, buyFeeBps}, refs, spot, createdAt, jar] = await Promise.all([
    fixed(token),
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'referencesThisBlock'}),
    publicClient.readContract({address: P!.venue, abi: venueAbi, functionName: 'spot', args: [token]}),
    c.createdAt || blockTimestamp(c.block),
    hero?.jar
      ? Promise.all([
          publicClient.readContract({address: hero.jar, abi: jarAbi, functionName: 'forwarded'}),
          publicClient.readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [hero.jar]}),
        ]).catch(() => [0n, 0n] as const)
      : null,
  ]);
  const priceEth = f(spot);
  return {
    token,
    curve: token,
    kind: 'pools',
    name,
    symbol,
    image: meta[2] || hero?.image || '',
    description: meta[0],
    creator: c.creator,
    createdAt,
    createdBlock: c.block,
    phase: 'pool',
    quoteReserve: 0,
    graduationThreshold: 0,
    priceEth,
    marketCapEth: priceEth * 1e9,
    referencesThisBlock: Number(refs),
    squarePaid,
    tradeCount,
    factory: c.factory,
    slowFree: Number(slowFree),
    twoRatchets: true,
    moonJarEth: jar ? f(jar[0]) + f(jar[1]) * priceEth : undefined,
    buyFeeBps: buyFeeBps || undefined,
    socials: {website: meta[1] || undefined},
  };
}

const paid = (ix: Index, token: Address) => f(ix.fees?.[token.toLowerCase()] ?? 0n);

export const pools = {
  /** Every Pools launch's token address, oldest first: the list alone, nothing read per token. */
  async tokens(to: bigint): Promise<Address[]> {
    return (await index(to)).created.map(c => c.token);
  },

  /** The same list for the activity feed, which counts swaps and fees itself: the creation scan alone, with each token's pool id. */
  async roster(to: bigint): Promise<Array<{token: Address; id: Hex; block: bigint}>> {
    return (await createdUpTo(to)).map(c => ({token: c.token, id: poolId(c.token), block: c.block}));
  },

  async launches(to?: bigint): Promise<Launch[]> {
    if (!poolsDeployed) return [];
    const ix = await index(to ?? (await publicClient.getBlockNumber()));
    return Promise.all(
      ix.created.map(async c => hydrate({...c, creator: await creatorOf(c), createdAt: c.ts}, ix.swaps?.[poolId(c.token)] ?? 0, paid(ix, c.token))),
    );
  },

  async launch(token: Address): Promise<Launch | null> {
    if (!poolsDeployed) return null;
    const ix = await index(await publicClient.getBlockNumber());
    const mine = ix.created.find(c => c.token.toLowerCase() === token.toLowerCase());
    if (!mine) return null;
    return hydrate({...mine, creator: await creatorOf(mine), createdAt: mine.ts}, ix.swaps?.[poolId(mine.token)] ?? 0, paid(ix, mine.token));
  },

  async refresh(l: Launch, tradeCount = l.tradeCount): Promise<Launch> {
    const ix = await index(await publicClient.getBlockNumber());
    // a failed fee read keeps the figure already on screen
    return hydrate({token: l.token, block: l.createdBlock, factory: l.factory, creator: l.creator, createdAt: l.createdAt}, tradeCount, ix.fees ? paid(ix, l.token) : l.squarePaid);
  },

  /** Pool swaps as trades. ETH is currency0: a negative amount0 is ETH paid in, so a buy. */
  async trades(token: Address, range: {from: bigint; to: bigint}): Promise<Trade[]> {
    if (range.from > range.to) return [];
    const logs = await swapLogs(token, range.from, range.to);
    const stamps = await Promise.all(logs.map(logTimestamp));
    return logs.map((l, i) => {
      const a0 = l.args.amount0!;
      const a1 = l.args.amount1!;
      const buy = a0 < 0n;
      const quote = f(a0 < 0n ? -a0 : a0);
      const tokens = f(a1 < 0n ? -a1 : a1);
      return {
        ts: stamps[i],
        block: l.blockNumber,
        side: buy ? 'buy' : 'sell',
        quote,
        tokens,
        price: tokens ? quote / tokens : 0,
        fee: (quote * LP_FEE) / 1_000_000,
        who: l.args.sender!,
        tx: l.transactionHash,
      };
    });
  },

  async references(token: Address, range: {from: bigint; to: bigint}): Promise<Reference[]> {
    if (range.from > range.to) return [];
    const logs = await getLogsChunked(
      (a, b) => publicClient.getLogs({address: token, event: tokenAbi[0], fromBlock: a, toBlock: b}),
      range.from,
      range.to,
    );
    const stamps = await Promise.all(logs.map(logTimestamp));
    return logs.map((l, i) => ({
      ts: stamps[i],
      block: l.blockNumber,
      from: l.args.from!,
      to: l.args.to!,
      n: Number(l.args.n!),
      fee: f(l.args.fee!),
      tx: l.transactionHash,
    }));
  },

  /** Quote from Uniswap's v4 quoter, which simulates the swap against the live pool. */
  async quote(token: Address, side: 'buy' | 'sell', amount: number, account: Address) {
    const [{result}, spot, taxBps] = await Promise.all([
      publicClient.simulateContract({
        account,
        address: QUOTER,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{poolKey: keyFor(token), zeroForOne: side === 'buy', exactAmount: wei(amount), hookData: '0x'}],
      }),
      publicClient.readContract({address: P!.venue, abi: venueAbi, functionName: 'spot', args: [token]}),
      side === 'buy' ? buyFee(token) : Promise.resolve(0),
    ]);
    // the pool's output; a buy fee is taken from it on the way to the buyer (the router's minimum is checked before that)
    const poolOut = f(result[0]);
    const out = poolOut * (1 - taxBps / 10_000);
    const price = f(spot);
    // execution price against spot, net of the pool's own fee
    const exec = side === 'buy' ? (poolOut ? amount / poolOut : 0) : amount ? poolOut / amount : 0;
    const gross = price ? (side === 'buy' ? exec / price - 1 : 1 - exec / price) * 100 : 0;
    return {out, feeBps: LP_FEE / 100, taxBps, snipeBps: 0, impact: Math.max(0, gross - LP_FEE / 10_000), price};
  },
};

/** One exact-input v4 swap through the universal router: swap, settle what is owed, take what is due. */
function swapCall(token: Address, buy: boolean, amountIn: bigint, minOut: bigint) {
  const swap = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              {name: 'currency0', type: 'address'},
              {name: 'currency1', type: 'address'},
              {name: 'fee', type: 'uint24'},
              {name: 'tickSpacing', type: 'int24'},
              {name: 'hooks', type: 'address'},
            ],
          },
          {name: 'zeroForOne', type: 'bool'},
          {name: 'amountIn', type: 'uint128'},
          {name: 'amountOutMinimum', type: 'uint128'},
          {name: 'minHopPriceX36', type: 'uint256'},
          {name: 'hookData', type: 'bytes'},
        ],
      },
    ],
    [{poolKey: keyFor(token), zeroForOne: buy, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x'}],
  );
  const pair = [{type: 'address'}, {type: 'uint256'}] as const;
  const input = encodeAbiParameters(
    [{type: 'bytes'}, {type: 'bytes[]'}],
    [
      '0x060c0f',
      [
        swap,
        encodeAbiParameters(pair, [buy ? ZERO : token, amountIn]),
        encodeAbiParameters(pair, [buy ? token : ZERO, minOut]),
      ],
    ],
  );
  return {commands: '0x10' as Hex, inputs: [input]};
}

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

export const poolsTx = {
  async buy(w: WalletClient, token: Address, quoteEth: number, minTokens: number, account: Address) {
    const value = wei(quoteEth);
    const c = swapCall(token, true, value, wei(minTokens));
    const hash = await w.writeContract({
      chain: robinhood,
      account,
      address: UNIVERSAL_ROUTER,
      abi: routerAbi,
      functionName: 'execute',
      args: [c.commands, c.inputs, deadline()],
      value,
    });
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  /** Selling goes through Permit2: the token approves Permit2 once, Permit2 approves the router. */
  async sell(w: WalletClient, token: Address, tokens: number, minQuote: number, account: Address) {
    const amount = wei(tokens);
    const allowance = await publicClient.readContract({address: token, abi: erc20Abi, functionName: 'allowance', args: [account, ADDR.permit2]});
    if (allowance < amount) {
      const a = await w.writeContract({chain: robinhood, account, address: token, abi: erc20Abi, functionName: 'approve', args: [ADDR.permit2, 2n ** 256n - 1n]});
      await publicClient.waitForTransactionReceipt({hash: a});
    }
    const [allowed, expires] = await publicClient.readContract({address: ADDR.permit2, abi: permit2Abi, functionName: 'allowance', args: [account, token, UNIVERSAL_ROUTER]});
    const now = Math.floor(Date.now() / 1000);
    if (allowed < amount || expires <= now + 600) {
      const a = await w.writeContract({
        chain: robinhood,
        account,
        address: ADDR.permit2,
        abi: permit2Abi,
        functionName: 'approve',
        args: [token, UNIVERSAL_ROUTER, 2n ** 160n - 1n, now + 30 * 86_400],
      });
      await publicClient.waitForTransactionReceipt({hash: a});
    }
    const c = swapCall(token, false, amount, wei(minQuote));
    const hash = await w.writeContract({
      chain: robinhood,
      account,
      address: UNIVERSAL_ROUTER,
      abi: routerAbi,
      functionName: 'execute',
      args: [c.commands, c.inputs, deadline()],
    });
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  /**
   * One transaction through the launcher: create the token with the Square factory, then put the
   * whole supply into an instant pool. The caller is the creator and receives the creator fee share.
   */
  async launch(w: WalletClient, account: Address, p: {name: string; symbol: string; description: string; website: string; image: string}) {
    const tokenData = encodeAbiParameters([metadataType], [{description: p.description, website: p.website, image: p.image, xProofTweetId: 0n}]);
    const graffiti = await publicClient.readContract({address: P!.launcher, abi: launcherAbi, functionName: 'getGraffiti', args: [account]});
    const token = await publicClient.readContract({
      address: LAUNCH_TOKEN_FACTORY!,
      abi: factoryAbi,
      functionName: 'getTokenAddress',
      args: [p.name, p.symbol, POOLS_SUPPLY, P!.launcher, tokenData, P!.launcher, graffiti],
    });
    if ((await publicClient.getCode({address: token})) !== undefined) throw new Error('You already launched a token with this name and ticker');
    const calls = [
      encodeFunctionData({abi: launcherAbi, functionName: 'createToken', args: [LAUNCH_TOKEN_FACTORY!, p.name, p.symbol, 18, POOLS_SUPPLY, P!.launcher, tokenData]}),
      encodeFunctionData({
        abi: launcherAbi,
        functionName: 'distributeToken',
        args: [
          token,
          {strategy: P!.instantStrategy, amount: POOLS_SUPPLY, configData: encodeAbiParameters([{type: 'address'}], [account])},
          `0x${'0'.repeat(64)}`,
        ],
      }),
    ];
    const hash = await w.writeContract({chain: robinhood, account, address: P!.launcher, abi: launcherAbi, functionName: 'multicall', args: [calls]});
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    if (receipt.status !== 'success') throw new Error('Launch reverted');
    known.add(token.toLowerCase());
    return {hash, token};
  },
};
