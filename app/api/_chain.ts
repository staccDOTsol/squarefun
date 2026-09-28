import type {Address} from 'viem';
import {decodeFunctionResult, encodeFunctionData, parseAbi} from 'viem/utils';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const deployment = JSON.parse(readFileSync(join(process.cwd(), 'src/deployments/4663.json'), 'utf8'));

export const ADDR = deployment as {factory: Address; factoryV2?: Address; deployBlock: number};
export const ZERO = '0x0000000000000000000000000000000000000000';
export const deployed = ADDR.factory !== ZERO;
export const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;
const RPC = process.env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';

export const factoryAbi = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
]);
export const curveAbi = parseAbi([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
]);
export const tokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function referencesThisBlock() view returns (uint256)',
  'function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, (string twitter, string telegram, string discord, string website, string farcaster) tokenSocials)',
]);

/** One JSON-RPC batch of eth_calls plus the block number; no client library, so it runs on the edge. */
async function rpc(calls: Array<{to: Address; data: `0x${string}`}>): Promise<{results: `0x${string}`[]; block: number}> {
  const body = [
    ...calls.map((c, i) => ({jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [{to: c.to, data: c.data}, 'latest']})),
    {jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: []},
  ];
  const res = await fetch(RPC, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const json = (await res.json()) as Array<{id: number; result?: `0x${string}`; error?: {message: string}}>;
  const byId = new Map(json.map(r => [r.id, r]));
  const results = calls.map((_, i) => {
    const r = byId.get(i + 1);
    if (!r || r.error || !r.result) throw new Error(r?.error?.message ?? 'rpc error');
    return r.result;
  });
  const b = byId.get(0)?.result ?? '0x0';
  return {results, block: parseInt(b, 16)};
}

export interface Card {
  token: Address;
  name: string;
  symbol: string;
  image: string;
  description: string;
  phase: number;
  raised: number;
  threshold: number;
  marketCapEth: number;
  refs: number;
  squarePaid: number;
  block: number;
}

const f = (x: bigint) => Number(x) / 1e18;

export function isAddress(s: string | null): s is Address {
  return !!s && /^0x[0-9a-fA-F]{40}$/.test(s);
}

export async function card(token: Address): Promise<Card | null> {
  if (!deployed) return null;
  const factories = [ADDR.factory, ...(ADDR.factoryV2 && ADDR.factoryV2 !== ZERO ? [ADDR.factoryV2] : [])];
  const first = await rpc(factories.map(fa => ({to: fa, data: encodeFunctionData({abi: factoryAbi, functionName: 'getLaunchedToken', args: [token]})})));
  const rec = first.results.map(r => decodeFunctionResult({abi: factoryAbi, functionName: 'getLaunchedToken', data: r})).find(r => r.exists);
  if (!rec) return null;
  const enc = (fn: 'name' | 'symbol' | 'totalSupply' | 'referencesThisBlock' | 'getTokenInfo') => encodeFunctionData({abi: tokenAbi, functionName: fn});
  const {results, block} = await rpc([
    {to: token, data: enc('name')},
    {to: token, data: enc('symbol')},
    {to: token, data: enc('totalSupply')},
    {to: token, data: enc('referencesThisBlock')},
    {to: token, data: encodeFunctionData({abi: tokenAbi, functionName: 'balanceOf', args: [DEAD]})},
    {to: rec.curve, data: encodeFunctionData({abi: curveAbi, functionName: 'getReserves'})},
    {to: rec.curve, data: encodeFunctionData({abi: curveAbi, functionName: 'realQuoteReserve'})},
    {to: token, data: enc('getTokenInfo')},
  ]);
  const name = decodeFunctionResult({abi: tokenAbi, functionName: 'name', data: results[0]});
  const symbol = decodeFunctionResult({abi: tokenAbi, functionName: 'symbol', data: results[1]});
  const supply = decodeFunctionResult({abi: tokenAbi, functionName: 'totalSupply', data: results[2]});
  const refs = decodeFunctionResult({abi: tokenAbi, functionName: 'referencesThisBlock', data: results[3]});
  const dead = decodeFunctionResult({abi: tokenAbi, functionName: 'balanceOf', data: results[4]});
  const reserves = decodeFunctionResult({abi: curveAbi, functionName: 'getReserves', data: results[5]});
  const real = decodeFunctionResult({abi: curveAbi, functionName: 'realQuoteReserve', data: results[6]});
  const info = decodeFunctionResult({abi: tokenAbi, functionName: 'getTokenInfo', data: results[7]});
  const price = reserves[1] === 0n ? 0 : f(reserves[0]) / f(reserves[1]);
  return {
    token,
    name,
    symbol,
    image: info[1],
    description: info[2],
    phase: rec.phase,
    raised: f(real),
    threshold: f(rec.graduationThreshold),
    marketCapEth: price * f(supply),
    refs: Number(refs),
    squarePaid: f(dead) * 2,
    block,
  };
}

export function fmtEth(n: number): string {
  const d = n >= 100 ? 1 : n >= 1 ? 3 : n >= 0.001 ? 4 : 6;
  return `${n.toLocaleString('en-US', {maximumFractionDigits: d})} ETH`;
}
