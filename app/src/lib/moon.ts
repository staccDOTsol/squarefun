import {encodeAbiParameters, keccak256, parseAbi, parseAbiItem, type Address, type Hex} from 'viem';
import {getLogsChunked, publicClient} from './chain';

/**
 * Moon drop draws, re-derived in the browser. For each drop: the jar's request names a drand round
 * (OpenVRF picks one 2-4 s after the request block, so nobody knows it when the round's tickets close);
 * we fetch that round from drand itself, check the router stored the same randomness, recompute the word
 * the router derived, and recompute which ticket holder the word lands on. Nothing here trusts the keeper.
 */

const jarAbi = parseAbi([
  'function token() view returns (address)',
  'function vrf() view returns (address)',
  'function parcels(uint256) view returns (string)',
]);
const tokenAbi = parseAbi([
  'function totalTickets(uint256 round) view returns (uint256)',
  'function holderOf(uint256 round, uint256 x) view returns (address)',
  'function ticketsOf(uint256 round, address who) view returns (uint256)',
]);
const routerAbi = parseAbi([
  'function CHAIN_HASH() view returns (bytes32)',
  'function roundRandomness(uint64 round) view returns (bytes32)',
]);
const dropped = parseAbiItem('event Dropped(uint256 indexed id, address indexed winner, uint256 round, uint256 parcel, string name, uint256 word)');
const requested = parseAbiItem('event Requested(uint256 indexed requestId, uint256 indexed round, uint256 tickets)');
const vrfRequested = parseAbiItem('event RandomnessRequested(uint256 indexed requestId, address indexed consumer, uint64 round)');
const vrfFulfilled = parseAbiItem('event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord)');

export type Draw = {
  id: number;
  winner: Address;
  round: number;
  parcel: string;
  word: bigint;
  requestId: number;
  drandRound: number;
  requestTx: Hex;
  fulfillTx: Hex;
  tickets: bigint;
  winnerTickets: bigint;
  checks: {drand: boolean | null; stored: boolean; word: boolean; winner: boolean};
};

export async function draws(jar: Address, fromBlock: bigint): Promise<Draw[]> {
  const to = await publicClient.getBlockNumber();
  const [token, router] = await Promise.all([
    publicClient.readContract({address: jar, abi: jarAbi, functionName: 'token'}),
    publicClient.readContract({address: jar, abi: jarAbi, functionName: 'vrf'}),
  ]);
  const logs = <T,>(fn: (a: bigint, b: bigint) => Promise<T[]>) => getLogsChunked(fn, fromBlock, to);
  const [drops, reqs, vReqs, vFul, chainHash] = await Promise.all([
    logs((a, b) => publicClient.getLogs({address: jar, event: dropped, fromBlock: a, toBlock: b})),
    logs((a, b) => publicClient.getLogs({address: jar, event: requested, fromBlock: a, toBlock: b})),
    logs((a, b) => publicClient.getLogs({address: router, event: vrfRequested, args: {consumer: jar}, fromBlock: a, toBlock: b})),
    logs((a, b) => publicClient.getLogs({address: router, event: vrfFulfilled, fromBlock: a, toBlock: b})),
    publicClient.readContract({address: router, abi: routerAbi, functionName: 'CHAIN_HASH'}),
  ]);
  const out: Draw[] = [];
  for (const d of drops) {
    const round = d.args.round!;
    const word = d.args.word!;
    // the request that won: the fulfilled one whose word is this drop's word (a late word from a superseded request does nothing)
    const ful = vFul.find(l => l.args.randomWord === word && l.transactionHash === d.transactionHash) ?? vFul.find(l => l.args.randomWord === word);
    const requestId = ful ? ful.args.requestId! : [...reqs].reverse().find(r => r.args.round === round)?.args.requestId ?? 0n;
    const vr = vReqs.find(l => l.args.requestId === requestId);
    const drandRound = vr ? Number(vr.args.round) : 0;
    const [stored, tickets, winnerTickets] = await Promise.all([
      publicClient.readContract({address: router, abi: routerAbi, functionName: 'roundRandomness', args: [BigInt(drandRound)]}),
      publicClient.readContract({address: token, abi: tokenAbi, functionName: 'totalTickets', args: [round]}),
      publicClient.readContract({address: token, abi: tokenAbi, functionName: 'ticketsOf', args: [round, d.args.winner!]}),
    ]);
    // drand's own copy of the round, straight from the beacon's public API
    let drand: boolean | null = null;
    try {
      const r = await fetch(`https://api.drand.sh/${chainHash.slice(2)}/public/${drandRound}`).then(x => x.json());
      drand = `0x${r.randomness}`.toLowerCase() === stored.toLowerCase();
    } catch {
      drand = null;
    }
    // OpenVRF: word = keccak256(abi.encode(CHAIN_HASH, roundRandomness, chainid, router, requestId, consumer))
    const recomputed = BigInt(
      keccak256(
        encodeAbiParameters(
          [{type: 'bytes32'}, {type: 'bytes32'}, {type: 'uint256'}, {type: 'address'}, {type: 'uint256'}, {type: 'address'}],
          [chainHash, stored, BigInt(await publicClient.getChainId()), router, requestId, jar],
        ),
      ),
    );
    const holder = tickets ? await publicClient.readContract({address: token, abi: tokenAbi, functionName: 'holderOf', args: [round, word % tickets]}) : null;
    out.push({
      id: Number(d.args.id),
      winner: d.args.winner!,
      round: Number(round),
      parcel: d.args.name!,
      word,
      requestId: Number(requestId),
      drandRound,
      requestTx: (vr?.transactionHash ?? '0x') as Hex,
      fulfillTx: d.transactionHash as Hex,
      tickets,
      winnerTickets,
      checks: {drand, stored: stored !== `0x${'0'.repeat(64)}`, word: recomputed === word, winner: holder?.toLowerCase() === d.args.winner!.toLowerCase()},
    });
  }
  return out.sort((a, b) => b.id - a.id);
}
