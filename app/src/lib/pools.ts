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
import {ADDR, ZERO, blockTimestamp, erc20Abi, getLogsChunked, publicClient, robinhood} from './chain';
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

async function createdLogs(to: bigint) {
  if (!poolsDeployed) return [];
  return getLogsChunked(
    (a, b) => publicClient.getLogs({address: LISTED_FACTORIES, event: factoryAbi[0], fromBlock: a, toBlock: b}),
    BigInt(P!.deployBlock),
    to,
  );
}

async function swapLogs(token: Address, from: bigint, to: bigint) {
  return getLogsChunked(
    (a, b) => publicClient.getLogs({address: ADDR.poolManager, event: managerAbi[0], args: {id: poolId(token)}, fromBlock: a, toBlock: b}),
    from,
    to,
  );
}

async function hydrate(token: Address, createdBlock: bigint, creator: Address, tradeCount: number, factory: Address = P!.tokenFactory): Promise<Launch> {
  known.add(token.toLowerCase());
  const to = await publicClient.getBlockNumber();
  const [name, symbol, refs, meta, spot, createdAt, feeLogs, slowFree] = await Promise.all([
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'name'}),
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'symbol'}),
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'referencesThisBlock'}),
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'metadata'}),
    publicClient.readContract({address: P!.venue, abi: venueAbi, functionName: 'spot', args: [token]}),
    blockTimestamp(createdBlock),
    getLogsChunked((a, b) => publicClient.getLogs({address: token, event: tokenAbi[0], fromBlock: a, toBlock: b}), createdBlock, to),
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'SLOW_FREE'}).catch(() => 16n),
  ]);
  const priceEth = f(spot);
  const hero = ADDR.hero && ADDR.hero.token.toLowerCase() === token.toLowerCase() ? ADDR.hero : null;
  let moonJarEth: number | undefined;
  if (hero?.jar) {
    const [fwd, held] = await Promise.all([
      publicClient.readContract({address: hero.jar, abi: jarAbi, functionName: 'forwarded'}),
      publicClient.readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [hero.jar]}),
    ]).catch(() => [0n, 0n] as const);
    moonJarEth = f(fwd) + f(held) * priceEth;
  }
  return {
    token,
    curve: token,
    kind: 'pools',
    name,
    symbol,
    image: meta[2] || hero?.image || '',
    description: meta[0],
    creator,
    createdAt,
    createdBlock,
    phase: 'pool',
    quoteReserve: 0,
    graduationThreshold: 0,
    priceEth,
    marketCapEth: priceEth * 1e9,
    referencesThisBlock: Number(refs),
    squarePaid: feeLogs.reduce((s, l) => s + f(l.args.fee ?? 0n), 0),
    tradeCount,
    factory,
    slowFree: Number(slowFree),
    twoRatchets: true,
    moonJarEth,
    socials: {website: meta[1] || undefined},
  };
}

export const pools = {
  async launches(): Promise<Launch[]> {
    if (!poolsDeployed) return [];
    const to = await publicClient.getBlockNumber();
    const logs = await createdLogs(to);
    return Promise.all(
      logs.map(async l => {
        const token = l.args.tokenAddress!;
        const [t, swaps] = await Promise.all([
          publicClient.getTransaction({hash: l.transactionHash}),
          swapLogs(token, l.blockNumber, to).catch(() => []),
        ]);
        return hydrate(token, l.blockNumber, t.from, swaps.length, l.address as Address);
      }),
    );
  },

  async launch(token: Address): Promise<Launch | null> {
    if (!poolsDeployed) return null;
    const to = await publicClient.getBlockNumber();
    const mine = (await createdLogs(to)).find(l => l.args.tokenAddress?.toLowerCase() === token.toLowerCase());
    if (!mine) return null;
    const [t, swaps] = await Promise.all([
      publicClient.getTransaction({hash: mine.transactionHash}),
      swapLogs(token, mine.blockNumber, to).catch(() => []),
    ]);
    return hydrate(mine.args.tokenAddress!, mine.blockNumber, t.from, swaps.length, mine.address as Address);
  },

  refresh(l: Launch, tradeCount = l.tradeCount): Promise<Launch> {
    return hydrate(l.token, l.createdBlock, l.creator, tradeCount, l.factory);
  },

  /** Pool swaps as trades. ETH is currency0: a negative amount0 is ETH paid in, so a buy. */
  async trades(token: Address, range: {from: bigint; to: bigint}): Promise<Trade[]> {
    if (range.from > range.to) return [];
    const logs = await swapLogs(token, range.from, range.to);
    const out: Trade[] = [];
    for (const l of logs) {
      const a0 = l.args.amount0!;
      const a1 = l.args.amount1!;
      const buy = a0 < 0n;
      const quote = f(a0 < 0n ? -a0 : a0);
      const tokens = f(a1 < 0n ? -a1 : a1);
      out.push({
        ts: await blockTimestamp(l.blockNumber),
        block: l.blockNumber,
        side: buy ? 'buy' : 'sell',
        quote,
        tokens,
        price: tokens ? quote / tokens : 0,
        fee: (quote * LP_FEE) / 1_000_000,
        who: l.args.sender!,
        tx: l.transactionHash,
      });
    }
    return out;
  },

  async references(token: Address, range: {from: bigint; to: bigint}): Promise<Reference[]> {
    if (range.from > range.to) return [];
    const logs = await getLogsChunked(
      (a, b) => publicClient.getLogs({address: token, event: tokenAbi[0], fromBlock: a, toBlock: b}),
      range.from,
      range.to,
    );
    const out: Reference[] = [];
    for (const l of logs) {
      out.push({
        ts: await blockTimestamp(l.blockNumber),
        block: l.blockNumber,
        from: l.args.from!,
        to: l.args.to!,
        n: Number(l.args.n!),
        fee: f(l.args.fee!),
        tx: l.transactionHash,
      });
    }
    return out;
  },

  /** Quote from Uniswap's v4 quoter, which simulates the swap against the live pool. */
  async quote(token: Address, side: 'buy' | 'sell', amount: number, account: Address) {
    const [{result}, spot] = await Promise.all([
      publicClient.simulateContract({
        account,
        address: QUOTER,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{poolKey: keyFor(token), zeroForOne: side === 'buy', exactAmount: wei(amount), hookData: '0x'}],
      }),
      publicClient.readContract({address: P!.venue, abi: venueAbi, functionName: 'spot', args: [token]}),
    ]);
    const out = f(result[0]);
    const price = f(spot);
    // execution price against spot, net of the pool's own fee
    const exec = side === 'buy' ? (out ? amount / out : 0) : amount ? out / amount : 0;
    const gross = price ? (side === 'buy' ? exec / price - 1 : 1 - exec / price) * 100 : 0;
    return {out, feeBps: LP_FEE / 100, taxBps: 0, snipeBps: 0, impact: Math.max(0, gross - LP_FEE / 10_000), price};
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
