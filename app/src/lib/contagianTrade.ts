import {encodeAbiParameters, formatUnits, parseAbi, parseUnits, type Address, type Hex, type WalletClient} from 'viem';
import {ADDR, ZERO, erc20Abi, publicClient, robinhood} from './chain';
import {USDG, type Asset} from './contagian';

/**
 * Buying and selling a Contagian token straight through its own pool, with Uniswap's universal
 * router. One swap is one transfer of the token, so the repetition fee that a wallet's built-in
 * swap pays (its route moves the token three times) does not apply.
 *
 * A token whose memequote is USDG can also be bought with ETH: ETH to USDG in the deepest
 * ETH/USDG pool, then USDG to the token, in one transaction.
 */

const UNIVERSAL_ROUTER: Address = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
const QUOTER: Address = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
const POOL = {fee: 2500, tickSpacing: 25};
const ETH_USDG = {fee: 100, tickSpacing: 1};

const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

type Key = {currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address};
type Hop = {key: Key; from: Address; to: Address};

const keyOf = (a: Address, b: Address, shape = POOL): Key => {
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return {currency0, currency1, ...shape, hooks: ZERO};
};

export const ETH: Asset = {address: ZERO, symbol: 'ETH', decimals: 18};

/** What a token can be bought with: its memequote, and ETH too when the memequote is USDG. */
export function payOptions(quote: Asset): Asset[] {
  return quote.address === ZERO || quote.address.toLowerCase() !== USDG.toLowerCase() ? [quote] : [ETH, quote];
}

function route(token: Address, quote: Asset, side: 'buy' | 'sell', pay: Asset): Hop[] {
  const pool = keyOf(token, quote.address);
  if (side === 'sell') return [{key: pool, from: token, to: quote.address}];
  if (pay.address === quote.address) return [{key: pool, from: quote.address, to: token}];
  return [
    {key: keyOf(ZERO, quote.address, ETH_USDG), from: ZERO, to: quote.address},
    {key: pool, from: quote.address, to: token},
  ];
}

/** What the pools would pay out for `amountIn`, hop by hop, from Uniswap's quoter. */
async function quoteOut(hops: Hop[], amountIn: bigint, account: Address): Promise<bigint> {
  let amount = amountIn;
  for (const h of hops) {
    const {result} = await publicClient.simulateContract({
      account,
      address: QUOTER,
      abi: quoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{poolKey: h.key, zeroForOne: h.from === h.key.currency0, exactAmount: amount, hookData: '0x'}],
    });
    amount = result[0];
  }
  return amount;
}

const swapType = [
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
] as const;
const pair = [{type: 'address'}, {type: 'uint256'}] as const;

/** Exact-input swaps along the route, then settle what is owed and take what is due. */
function call(hops: Hop[], amountIn: bigint, minOut: bigint) {
  const last = hops.length - 1;
  const swaps = hops.map((h, i) =>
    encodeAbiParameters(swapType, [
      {
        poolKey: h.key,
        zeroForOne: h.from === h.key.currency0,
        // a later hop spends whatever the hop before it left: zero means "all of it"
        amountIn: i === 0 ? amountIn : 0n,
        amountOutMinimum: i === last ? minOut : 0n,
        minHopPriceX36: 0n,
        hookData: '0x',
      },
    ]),
  );
  const actions = `0x${'06'.repeat(hops.length)}0c0f` as Hex;
  const input = encodeAbiParameters(
    [{type: 'bytes'}, {type: 'bytes[]'}],
    [actions, [...swaps, encodeAbiParameters(pair, [hops[0].from, amountIn]), encodeAbiParameters(pair, [hops[last].to, minOut])]],
  );
  return {commands: '0x10' as Hex, inputs: [input]};
}

/** An ERC-20 the router pulls goes through Permit2: the token approves Permit2, Permit2 approves the router. */
async function allow(w: WalletClient, account: Address, token: Address, amount: bigint) {
  const allowance = await publicClient.readContract({address: token, abi: erc20Abi, functionName: 'allowance', args: [account, ADDR.permit2]});
  if (allowance < amount) {
    const a = await w.writeContract({chain: robinhood, account, address: token, abi: erc20Abi, functionName: 'approve', args: [ADDR.permit2, 2n ** 256n - 1n]});
    await publicClient.waitForTransactionReceipt({hash: a});
  }
  const [allowed, expires] = await publicClient.readContract({address: ADDR.permit2, abi: permit2Abi, functionName: 'allowance', args: [account, token, UNIVERSAL_ROUTER]});
  const now = Math.floor(Date.now() / 1000);
  if (allowed < amount || expires <= now + 600) {
    const a = await w.writeContract({chain: robinhood, account, address: ADDR.permit2, abi: permit2Abi, functionName: 'approve', args: [token, UNIVERSAL_ROUTER, 2n ** 160n - 1n, now + 30 * 86_400]});
    await publicClient.waitForTransactionReceipt({hash: a});
  }
}

const balanceOf = (asset: Address, who: Address) =>
  asset === ZERO ? publicClient.getBalance({address: who}) : publicClient.readContract({address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [who]});

export const contagianTrade = {
  /** The wallet's balances of what it can pay with and of the token, as numbers. */
  async balances(token: Address, quote: Asset, who: Address) {
    const assets = [...payOptions(quote), {address: token, symbol: '', decimals: 18}];
    const raw = await Promise.all(assets.map(a => balanceOf(a.address, who)));
    return Object.fromEntries(assets.map((a, i) => [a.address.toLowerCase(), Number(formatUnits(raw[i], a.decimals))])) as Record<string, number>;
  },

  /** What the pools pay for `amount` of `pay` (a buy) or of the token (a sale), before any tax the token takes. */
  async estimate(token: Address, quote: Asset, side: 'buy' | 'sell', pay: Asset, amount: string, account: Address) {
    const input = side === 'buy' ? pay : {decimals: 18};
    const amountIn = parseUnits(amount, input.decimals);
    if (amountIn === 0n) return 0;
    const out = await quoteOut(route(token, quote, side, pay), amountIn, account);
    return Number(formatUnits(out, side === 'buy' ? 18 : quote.decimals));
  },

  async buy(w: WalletClient, account: Address, token: Address, quote: Asset, pay: Asset, amount: string, slippageBps = 300) {
    const hops = route(token, quote, 'buy', pay);
    const amountIn = parseUnits(amount, pay.decimals);
    const minOut = ((await quoteOut(hops, amountIn, account)) * BigInt(10_000 - slippageBps)) / 10_000n;
    if (pay.address !== ZERO) await allow(w, account, pay.address, amountIn);
    const c = call(hops, amountIn, minOut);
    const args = [c.commands, c.inputs, BigInt(Math.floor(Date.now() / 1000) + 600)] as const;
    const value = pay.address === ZERO ? amountIn : 0n;
    await publicClient.simulateContract({account, address: UNIVERSAL_ROUTER, abi: routerAbi, functionName: 'execute', args, value});
    const hash = await w.writeContract({chain: robinhood, account, address: UNIVERSAL_ROUTER, abi: routerAbi, functionName: 'execute', args, value});
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    if (receipt.status !== 'success') throw new Error('The buy reverted');
    return hash;
  },

  /**
   * A sale under parity is taxed on top: the pool gets the whole amount and the tax comes out of
   * what the wallet has left. If nothing is left to pay it with, the sale reverts; the simulation
   * says so before anything is sent.
   */
  async sell(w: WalletClient, account: Address, token: Address, quote: Asset, amount: string, slippageBps = 300) {
    const hops = route(token, quote, 'sell', quote);
    const amountIn = parseUnits(amount, 18);
    const minOut = ((await quoteOut(hops, amountIn, account)) * BigInt(10_000 - slippageBps)) / 10_000n;
    await allow(w, account, token, amountIn);
    const c = call(hops, amountIn, minOut);
    const args = [c.commands, c.inputs, BigInt(Math.floor(Date.now() / 1000) + 600)] as const;
    try {
      await publicClient.simulateContract({account, address: UNIVERSAL_ROUTER, abi: routerAbi, functionName: 'execute', args});
    } catch {
      throw new Error('This sale would revert. The sell tax is taken on top, from what you have left: sell less than your whole balance.');
    }
    const hash = await w.writeContract({chain: robinhood, account, address: UNIVERSAL_ROUTER, abi: routerAbi, functionName: 'execute', args});
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    if (receipt.status !== 'success') throw new Error('The sale reverted');
    return hash;
  },
};
