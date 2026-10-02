import {formatEther, parseEther, type Address, type WalletClient} from 'viem';
import {
  ADDR,
  DEAD,
  FACTORIES,
  LAUNCH_FACTORY,
  ZERO,
  blockTimestamp,
  logTimestamp,
  scan,
  curveAbi,
  deployed,
  erc20Abi,
  factoryAbi,
  getLogsChunked,
  migrateAbi,
  migrateFactoryAbi,
  publicClient,
  scooperDeployed,
  scoopBatchAbi,
  batchDeployed,
  LAMBDA_URL,
  wizardsAbi,
  settlerAbi,
  WETH,
  robinhood,
  sinkAbi,
  tokenAbi,
} from './chain';
import {isPoolsToken, pools, poolsTx} from './pools';
import type {Distribution, Launch, LaunchConfig, Migration, MigrationStage, Reference, SinkState, Trade, WalletToken} from './types';

/**
 * Every read on the site goes through here and comes from Robinhood Chain.
 * There is no cached or sample data: an undeployed factory means empty lists.
 */

const PHASES = ['curve', 'swept', 'pool', 'rescued'] as const;
const f = (x: bigint) => Number(formatEther(x));

/** Blocks to look back for trade and reference logs (~250 ms blocks on Robinhood). */
const LOOKBACK = 400_000n;

async function latestBlock(): Promise<bigint> {
  return publicClient.getBlockNumber();
}

type Launched = {token: Address; curve: Address; deployer: Address; block: bigint; factory: Address; ts: number};

/** Every TokenLaunched from every factory, oldest first. Read once per browser, then only the new blocks. */
function launched(to: bigint): Promise<Launched[]> {
  return scan({
    key: `launched:${FACTORIES.join()}`,
    read: (a, b) => publicClient.getLogs({address: FACTORIES, event: factoryAbi[0], fromBlock: a, toBlock: b}),
    addresses: FACTORIES.length,
    from: BigInt(ADDR.deployBlock),
    to,
    init: [] as Launched[],
    fold: (acc, logs) => [
      ...acc,
      ...logs.map(l => ({token: l.args.token!, curve: l.args.curve!, deployer: l.args.deployer!, block: l.blockNumber, factory: l.address as Address, ts: Number(l.blockTimestamp ?? 0n) * 1000})),
    ],
  });
}

/** Curve trades in the lookback window, counted per curve (lowercase). The window slides: each call reads only the new blocks. */
async function tradeCounts(curves: Address[], to: bigint): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (curves.length === 0) return counts;
  const from = to > LOOKBACK ? to - LOOKBACK : BigInt(ADDR.deployBlock);
  const seen = await scan({
    key: 'curve-trades',
    read: (a, b) => publicClient.getLogs({address: curves, events: [curveAbi[0], curveAbi[1]], fromBlock: a, toBlock: b}),
    addresses: curves.length,
    from,
    to,
    init: [] as Array<{curve: string; block: bigint}>,
    // log.address is lowercase from the RPC; decoded args are checksummed. Key by lowercase.
    fold: (acc, logs) => [...acc.filter(t => t.block >= from), ...logs.map(l => ({curve: l.address.toLowerCase(), block: l.blockNumber}))],
    keep: false,
  });
  for (const t of seen) if (t.block >= from) counts.set(t.curve, (counts.get(t.curve) ?? 0) + 1);
  return counts;
}

/** The factory that launched `token`, with its record; null when none did. The newest factory wins. */
async function recordFor(token: Address) {
  const records = await Promise.all(
    FACTORIES.map(factory => publicClient.readContract({address: factory, abi: factoryAbi, functionName: 'getLaunchedToken', args: [token]})),
  );
  for (let i = FACTORIES.length - 1; i >= 0; i--) if (records[i].exists) return {factory: FACTORIES[i], record: records[i]};
  return null;
}

/** What a launch fixed at creation: read once per page view. */
const statics = new Map<string, ReturnType<typeof readFixed>>();
function readFixed(token: Address, curve: Address) {
  return Promise.all([
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'getTokenInfo'}),
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'name'}),
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'symbol'}),
    publicClient.readContract({address: curve, abi: curveAbi, functionName: 'graduationThreshold'}),
    // v1 tokens have no slow ratchet; the probe reverts and that is the answer
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'slowFeeBps', args: [2n]}).then(() => true).catch(() => false),
  ]);
}
function fixed(token: Address, curve: Address) {
  const k = token.toLowerCase();
  let hit = statics.get(k);
  if (!hit) {
    hit = readFixed(token, curve);
    hit.catch(() => statics.delete(k));
    statics.set(k, hit);
  }
  return hit;
}

async function hydrate(token: Address, curve: Address, creator: Address, createdBlock: bigint, tradeCount: number, factory: Address, createdTs = 0): Promise<Launch> {
  const [[info, name, symbol, threshold, slow], totalSupply, refs, deadBal, reserves, realQuote, record, createdAt] = await Promise.all([
    fixed(token, curve),
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'totalSupply'}),
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'referencesThisBlock'}),
    publicClient.readContract({address: token, abi: tokenAbi, functionName: 'balanceOf', args: [DEAD]}),
    publicClient.readContract({address: curve, abi: curveAbi, functionName: 'getReserves'}),
    publicClient.readContract({address: curve, abi: curveAbi, functionName: 'realQuoteReserve'}),
    publicClient.readContract({address: factory, abi: factoryAbi, functionName: 'getLaunchedToken', args: [token]}),
    createdTs || blockTimestamp(createdBlock),
  ]);
  const [vq, vt] = reserves;
  const priceEth = vt === 0n ? 0 : f(vq) / f(vt);
  const s = info[3];
  return {
    token,
    curve,
    name,
    symbol,
    image: info[1],
    description: info[2],
    creator,
    createdAt,
    createdBlock,
    phase: PHASES[record.phase] ?? 'curve',
    quoteReserve: f(realQuote),
    graduationThreshold: f(threshold),
    priceEth,
    marketCapEth: priceEth * f(totalSupply),
    referencesThisBlock: Number(refs),
    squarePaid: f(deadBal) * 2,
    tradeCount,
    factory,
    twoRatchets: slow,
    socials: {twitter: s.twitter || undefined, telegram: s.telegram || undefined, discord: s.discord || undefined, website: s.website || undefined, farcaster: s.farcaster || undefined},
  };
}

export const data = {
  deployed,

  async config(): Promise<LaunchConfig | null> {
    if (!deployed) return null;
    const [c, fee, maxTax] = await Promise.all([
      publicClient.readContract({address: LAUNCH_FACTORY, abi: factoryAbi, functionName: 'getLaunchConfig', args: [0n]}),
      publicClient.readContract({address: LAUNCH_FACTORY, abi: factoryAbi, functionName: 'launchFee'}),
      publicClient.readContract({address: LAUNCH_FACTORY, abi: factoryAbi, functionName: 'maxCreatorTaxBps'}),
    ]);
    return {
      supply: f(c.supply),
      curveFeeBps: Number(c.curveFeeBps),
      phantomQuote: f(c.phantomQuote),
      graduationThreshold: f(c.graduationThreshold),
      poolFee: c.poolFee,
      tickSpacing: c.tickSpacing,
      enabled: c.enabled,
      launchFee: f(fee),
      maxCreatorTaxBps: Number(maxTax),
    };
  },

  async launches(): Promise<Launch[]> {
    if (!deployed) return [];
    const to = await latestBlock();
    const [pad, viaPools] = await Promise.all([
      (async () => {
        const list = await launched(to);
        // activity and each launch's live numbers go out together
        const [counts, rows] = await Promise.all([
          tradeCounts(list.map(l => l.curve), to),
          Promise.all(list.map(l => hydrate(l.token, l.curve, l.deployer, l.block, 0, l.factory, l.ts))),
        ]);
        return rows.map(r => ({...r, tradeCount: counts.get(r.curve.toLowerCase()) ?? 0}));
      })(),
      // a failure reading Pools launches must not empty the board
      pools.launches(to).catch(() => [] as Launch[]),
    ]);
    return [...pad, ...viaPools];
  },

  async launch(token: Address): Promise<Launch | null> {
    if (!deployed) return null;
    const [found, to] = await Promise.all([recordFor(token), latestBlock()]);
    if (!found) return pools.launch(token);
    const {factory, record} = found;
    const from = to > LOOKBACK ? to - LOOKBACK : BigInt(ADDR.deployBlock);
    const [list, tradeLogs] = await Promise.all([
      launched(to),
      getLogsChunked(
        (a, b) => publicClient.getLogs({address: record.curve, events: [curveAbi[0], curveAbi[1]], fromBlock: a, toBlock: b}),
        from,
        to,
      ),
    ]);
    const mine = list.find(l => l.token.toLowerCase() === token.toLowerCase());
    return hydrate(token, record.curve, record.deployer, mine?.block ?? BigInt(ADDR.deployBlock), tradeLogs.length, factory, mine?.ts);
  },

  /**
   * Every listed token as of block `to`, for the activity feed: pad launches with their curves and
   * Pools launches with their pool ids. Two remembered scans, nothing read per token.
   */
  async roster(to: bigint): Promise<{pad: Array<{token: Address; curve: Address}>; pools: Array<{token: Address; id: `0x${string}`; block: bigint}>}> {
    if (!deployed) return {pad: [], pools: []};
    const [pad, viaPools] = await Promise.all([launched(to), pools.roster(to).catch(() => [])]);
    return {pad: pad.map(l => ({token: l.token, curve: l.curve})), pools: viaPools};
  },

  /** Current chain head. Pages poll this to know when there is something new to read. */
  head(): Promise<bigint> {
    return latestBlock();
  },

  /** Re-read a launch's live numbers (reserves, references this block, phase). Cheap: one batched call. */
  async refresh(l: Launch, tradeCount = l.tradeCount): Promise<Launch> {
    if (l.kind === 'pools') return pools.refresh(l, tradeCount);
    return hydrate(l.token, l.curve, l.creator, l.createdBlock, tradeCount, l.factory, l.createdAt);
  },

  /**
   * Curve trades. With no range, the lookback window up to the head; with a range, exactly those blocks
   * (used for incremental live updates).
   */
  async trades(curve: Address, range?: {from: bigint; to: bigint}): Promise<Trade[]> {
    const to = range?.to ?? (await latestBlock());
    const from = range?.from ?? (to > LOOKBACK ? to - LOOKBACK : BigInt(ADDR.deployBlock));
    if (from > to) return [];
    // a Pools launch has no curve; its "curve" is the token and its trades are pool swaps
    if (isPoolsToken(curve)) return pools.trades(curve, {from, to});
    const logs = await getLogsChunked(
      (a, b) => publicClient.getLogs({address: curve, events: [curveAbi[0], curveAbi[1]], fromBlock: a, toBlock: b}),
      from,
      to,
    );
    const stamps = await Promise.all(logs.map(logTimestamp));
    return logs.map((l, i) => {
      const buy = l.eventName === 'CurveBuy';
      const a = l.args as {quoteIn?: bigint; tokensOut?: bigint; tokensIn?: bigint; quoteOut?: bigint; fee: bigint; buyer?: Address; seller?: Address};
      const quote = f(buy ? a.quoteIn! : a.quoteOut!);
      const tokens = f(buy ? a.tokensOut! : a.tokensIn!);
      return {
        ts: stamps[i],
        block: l.blockNumber,
        side: buy ? 'buy' : 'sell',
        quote,
        tokens,
        price: tokens ? quote / tokens : 0,
        fee: f(a.fee),
        who: (buy ? a.buyer : a.seller)!,
        tx: l.transactionHash,
      };
    });
  },

  async references(token: Address, range?: {from: bigint; to: bigint}): Promise<Reference[]> {
    const to = range?.to ?? (await latestBlock());
    const from = range?.from ?? (to > LOOKBACK ? to - LOOKBACK : BigInt(ADDR.deployBlock));
    if (from > to) return [];
    const logs = await getLogsChunked(
      (a, b) => publicClient.getLogs({address: token, event: tokenAbi[0], fromBlock: a, toBlock: b}),
      from,
      to,
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

  async sink(you?: Address): Promise<SinkState | null> {
    if (!deployed) return null;
    const legacy = ADDR.legacySink;
    const [totalStaked, poolBps, legacyBps, yourStake, yourWallet] = await Promise.all([
      publicClient.readContract({address: ADDR.sink, abi: sinkAbi, functionName: 'totalStaked'}),
      publicClient.readContract({address: ADDR.sink, abi: sinkAbi, functionName: 'wizardsBps'}),
      legacy ? publicClient.readContract({address: legacy, abi: sinkAbi, functionName: 'wizardsBps'}) : Promise.resolve(0n),
      you ? publicClient.readContract({address: ADDR.sink, abi: sinkAbi, functionName: 'staked', args: [you]}) : Promise.resolve(0n),
      you ? publicClient.readContract({address: ADDR.square, abi: erc20Abi, functionName: 'balanceOf', args: [you]}) : Promise.resolve(0n),
    ]);
    // the wizards' cut is taken once, upstream if there is an upstream
    const wizardsBps = Number(poolBps) + Number(legacyBps);
    const to = await latestBlock();
    // every launch is a potential payer; show the ones with anything landed or distributed
    // every launch, plus WETH: the settler pays the pool in wrapped ETH
    // launches made through Pools pay their own settler; its venue is the token's v4 pool
    const [launches, viaPools] = await Promise.all([launched(to), pools.tokens(to).catch(() => [] as Address[])]);
    const poolsSet = new Set(viaPools.map(t => t.toLowerCase()));
    const tokens = [...new Set([...launches.map(l => l.token.toLowerCase() as Address), ...viaPools.map(t => t.toLowerCase() as Address), WETH.toLowerCase() as Address])].filter(t => t !== ADDR.placeholder?.toLowerCase());
    const perToken = await Promise.all(
      tokens.map(async token => {
        const [symbol, count, claimable, poolBal, poolReserved, legacyBal, legacyReserved, wizBal, wizReserved, settlerBal] = await Promise.all([
          publicClient.readContract({address: token, abi: tokenAbi, functionName: 'symbol'}).catch(() => 'TOKEN'),
          publicClient.readContract({address: ADDR.sink, abi: sinkAbi, functionName: 'distributionCount', args: [token]}),
          you ? publicClient.readContract({address: ADDR.sink, abi: sinkAbi, functionName: 'claimable', args: [you, token]}) : Promise.resolve(0n),
          publicClient.readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [ADDR.sink]}),
          publicClient.readContract({address: ADDR.sink, abi: sinkAbi, functionName: 'reserved', args: [token]}),
          legacy ? publicClient.readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [legacy]}) : Promise.resolve(0n),
          legacy ? publicClient.readContract({address: legacy, abi: sinkAbi, functionName: 'reserved', args: [token]}) : Promise.resolve(0n),
          publicClient.readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [ADDR.wizards]}),
          publicClient.readContract({address: ADDR.wizards, abi: wizardsAbi, functionName: 'reserved', args: [token]}).catch(() => 0n),
          (() => {
            const settler = poolsSet.has(token) ? ADDR.pools?.settler : ADDR.settler;
            return settler ? publicClient.readContract({address: token, abi: erc20Abi, functionName: 'balanceOf', args: [settler]}).catch(() => 0n) : Promise.resolve(0n);
          })(),
        ]);
        const distributions: Distribution[] = await Promise.all(
          Array.from({length: Number(count)}, async (_, i) => {
            const d = await publicClient.readContract({address: ADDR.sink, abi: sinkAbi, functionName: 'distribution', args: [token, BigInt(i)]});
            return {token, symbol, index: i, block: Number(d.blockNumber), amount: f(d.amount), totalStakedBefore: f(d.totalStakedBefore)};
          }),
        );
        // waiting = landed upstream but not yet pulled, plus landed here but not yet synced
        const upstream = legacyBal > legacyReserved ? legacyBal - legacyReserved : 0n;
        const here = poolBal > poolReserved ? poolBal - poolReserved : 0n;
        // the wizards' cut arrives at sync but their fanout only counts it once someone harvests
        const wizardsUnharvested = wizBal > wizReserved ? f(wizBal - wizReserved) : 0;
        return {token, symbol, distributions, claimable: f(claimable), pending: f(upstream + here), wizardsUnharvested, settlerPending: f(settlerBal)};
      }),
    );
    return {
      totalStaked: f(totalStaked),
      wizardsBps,
      yourStake: f(yourStake),
      yourWallet: f(yourWallet),
      tokens: perToken.filter(t => t.distributions.length > 0 || t.pending > 0 || t.wizardsUnharvested > 0 || t.settlerPending > 0),
    };
  },

  /**
   * Every ERC-20 the wallet holds on Robinhood (dRPC wallet API), with whether the scooper can sell it.
   * Native ETH and $SQUARE itself are left out.
   */
  async walletTokens(you: Address): Promise<WalletToken[]> {
    if (!LAMBDA_URL || !batchDeployed) return [];
    const res = await fetch(`${LAMBDA_URL}/v2/wallets/${you}/balances?chains=robinhood`);
    if (!res.ok) throw new Error(`wallet api ${res.status}`);
    const j = (await res.json()) as {data: {assets: Array<{type: string; chain_id_numeric: number; value_usd?: number; attributes: {contract_address: string | null; token_symbol: string; token_name: string; decimals: number; amount_string: string}}>}};
    const rows = j.data.assets
      .filter(a => a.type === 'token' && a.chain_id_numeric === 4663 && a.attributes.contract_address)
      .map(a => ({
        address: a.attributes.contract_address!.toLowerCase() as Address,
        symbol: a.attributes.token_symbol || 'TOKEN',
        name: a.attributes.token_name || 'Token',
        decimals: a.attributes.decimals ?? 18,
        raw: BigInt(a.attributes.amount_string || '0'),
        usd: a.value_usd ?? 0,
      }))
      .filter(t => t.raw > 0n && t.address !== ADDR.square.toLowerCase());
    if (rows.length === 0) return [];
    // one call: can the scooper sell each, and does it already have an open takeover
    const [ok, needsNew] = await publicClient.readContract({address: ADDR.scoopBatch!, abi: scoopBatchAbi, functionName: 'preview', args: [rows.map(r => r.address)]});
    return rows
      .map((r, i) => ({...r, amount: Number(r.raw) / 10 ** r.decimals, ok: ok[i], needsNew: needsNew[i]}))
      .sort((a, b) => Number(b.ok) - Number(a.ok) || b.usd - a.usd);
  },

  /** Every takeover the factory has created, newest first. */
  async migrations(): Promise<Address[]> {
    if (!scooperDeployed) return [];
    const to = await latestBlock();
    const made = await scan({
      key: `migrations:${ADDR.migrateFactory}`,
      read: (a, b) => publicClient.getLogs({address: ADDR.migrateFactory!, event: migrateFactoryAbi[0], fromBlock: a, toBlock: b}),
      from: BigInt(ADDR.deployBlock),
      to,
      init: [] as Address[],
      fold: (acc, logs) => [...acc, ...logs.map(l => l.args.migrate!)],
    });
    return [...made].reverse();
  },

  /** Which venue would sell `token`, plus its name and symbol; venue is zero when nothing can. */
  async scoopable(token: Address): Promise<{venue: Address; name: string; symbol: string; existing: Address[]}> {
    const [venue, name, symbol, existing] = await Promise.all([
      publicClient.readContract({address: ADDR.migrateFactory!, abi: migrateFactoryAbi, functionName: 'venueFor', args: [token]}),
      publicClient.readContract({address: token, abi: tokenAbi, functionName: 'name'}).catch(() => 'Token') as Promise<string>,
      publicClient.readContract({address: token, abi: tokenAbi, functionName: 'symbol'}).catch(() => 'TOKEN') as Promise<string>,
      publicClient.readContract({address: ADDR.migrateFactory!, abi: migrateFactoryAbi, functionName: 'byToken', args: [token]}),
    ]);
    return {venue, name, symbol, existing: [...existing]};
  },

  /** Everything about one takeover, from chain. */
  async migration(address: Address, you?: Address): Promise<Migration> {
    const r = (fn: string, args: unknown[] = []): Promise<unknown> =>
      publicClient.readContract({address, abi: migrateAbi, functionName: fn as never, args: args as never}) as Promise<unknown>;
    const [oldToken, venue, start, epochLength, epochs, decayBps, mandate, sellCapBps, cooldown, recoverDeadline, vestLength, claimWindow] =
      (await Promise.all(
        ['oldToken', 'venue', 'start', 'epochLength', 'epochs', 'decayBps', 'mandate', 'sellCapBps', 'cooldown', 'recoverDeadline', 'vestLength', 'claimWindow'].map(f => r(f)),
      )) as unknown as [Address, Address, bigint, bigint, number, number, bigint, number, bigint, bigint, bigint, bigint];
    const [totalDeposited, totalCredits, remaining, recovered, totalSquare, lastSell, claimStart, converted, rescued, failed, depositsOpen, canRecover] =
      (await Promise.all(
        ['totalDeposited', 'totalCredits', 'remaining', 'recovered', 'totalSquare', 'lastSell', 'claimStart', 'converted', 'rescued', 'failed', 'depositsOpen', 'canRecover'].map(f => r(f)),
      )) as unknown as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean];
    const now = BigInt(Math.floor(Date.now() / 1000));
    const [oldSymbol, oldName, epochNow] = await Promise.all([
      publicClient.readContract({address: oldToken, abi: tokenAbi, functionName: 'symbol'}).catch(() => 'TOKEN') as Promise<string>,
      publicClient.readContract({address: oldToken, abi: tokenAbi, functionName: 'name'}).catch(() => 'Token') as Promise<string>,
      r('epochAt', [now]) as Promise<number>,
    ]);
    const rateNowBps = Number(await r('rateBps', [Math.min(epochNow, epochs - 1)]));
    let yours: Migration['you'] = null;
    if (you) {
      const [d, c, cl, ca, rb, bal, al] = (await Promise.all([
        r('deposited', [you]),
        r('credits', [you]),
        r('claimed', [you]),
        r('claimable', [you]),
        r('rescuedBy', [you]),
        publicClient.readContract({address: oldToken, abi: erc20Abi, functionName: 'balanceOf', args: [you]}),
        publicClient.readContract({address: oldToken, abi: erc20Abi, functionName: 'allowance', args: [you, address]}),
      ])) as unknown as [bigint, bigint, bigint, bigint, boolean, bigint, bigint];
      yours = {deposited: f(d), credits: f(c), claimed: f(cl), claimable: f(ca), rescued: rb, oldBalance: f(bal), oldAllowance: f(al)};
    }
    const to = await latestBlock();
    const depositors = (
      await scan({
        key: `depositors:${address}`,
        read: (a, b) => publicClient.getLogs({address, event: migrateAbi[0], fromBlock: a, toBlock: b}),
        from: BigInt(ADDR.deployBlock),
        to,
        init: [] as string[],
        fold: (acc, logs) => [...new Set([...acc, ...logs.map(l => l.args.who!.toLowerCase())])],
      })
    ).length;
    let stage: MigrationStage;
    if (converted) stage = 'claims';
    else if (failed || rescued) stage = 'failed';
    else if (depositsOpen && !(now >= start + epochLength && totalDeposited >= mandate)) stage = 'deposits';
    else if (remaining === 0n && totalDeposited !== 0n) stage = 'convert';
    else if (now >= start + epochLength && totalDeposited >= mandate) stage = 'recovering';
    else stage = depositsOpen ? 'deposits' : 'waiting';
    return {
      address,
      oldToken,
      oldSymbol,
      oldName,
      venue,
      start: Number(start),
      epochLength: Number(epochLength),
      epochs,
      decayBps,
      mandate: f(mandate),
      sellCapBps,
      cooldown: Number(cooldown),
      recoverDeadline: Number(recoverDeadline),
      vestLength: Number(vestLength),
      claimWindow: Number(claimWindow),
      totalDeposited: f(totalDeposited),
      totalCredits: f(totalCredits),
      remaining: f(remaining),
      recovered: f(recovered),
      totalSquare: f(totalSquare),
      lastSell: Number(lastSell),
      claimStart: Number(claimStart),
      converted,
      rescued,
      failed,
      depositsOpen,
      canRecover,
      epochNow,
      rateNowBps,
      stage,
      you: yours,
      depositors,
    };
  },

  /** Curve quote preview from live reserves and the fee terms the curve reports. */
  async quote(curve: Address, side: 'buy' | 'sell', amount: number, recipient: Address) {
    if (isPoolsToken(curve)) return pools.quote(curve, side, amount, recipient);
    const [reserves, feeBps, taxBps, snipeBps] = await Promise.all([
      publicClient.readContract({address: curve, abi: curveAbi, functionName: 'getReserves'}),
      publicClient.readContract({address: curve, abi: curveAbi, functionName: 'feeBps'}),
      publicClient.readContract({address: curve, abi: curveAbi, functionName: 'creatorTaxBps'}),
      publicClient.readContract({address: curve, abi: curveAbi, functionName: 'currentSnipeTaxBps', args: [recipient]}),
    ]);
    const vq = f(reserves[0]);
    const vt = f(reserves[1]);
    const totalBps = Number(feeBps) + Number(taxBps) + Number(snipeBps);
    if (side === 'buy') {
      const net = amount * (1 - totalBps / 10_000);
      const out = vt - (vq * vt) / (vq + net);
      return {out, feeBps: Number(feeBps), taxBps: Number(taxBps), snipeBps: Number(snipeBps), impact: (net / (vq + net)) * 100, price: vq / vt};
    }
    const gross = vq - (vq * vt) / (vt + amount);
    const out = gross * (1 - totalBps / 10_000);
    return {out, feeBps: Number(feeBps), taxBps: Number(taxBps), snipeBps: Number(snipeBps), impact: (amount / (vt + amount)) * 100, price: vq / vt};
  },
};

/** Writes. Every function returns the transaction hash after it is mined. */
export const tx = {
  async buy(w: WalletClient, curve: Address, quoteEth: number, minTokens: number, recipient: Address) {
    if (isPoolsToken(curve)) return poolsTx.buy(w, curve, quoteEth, minTokens, recipient);
    const value = parseEther(quoteEth.toFixed(18));
    const hash = await w.writeContract({
      chain: robinhood,
      account: recipient,
      address: curve,
      abi: curveAbi,
      functionName: 'buy',
      args: [value, parseEther(Math.max(0, minTokens).toFixed(18)), recipient],
      value,
    });
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  async sell(w: WalletClient, token: Address, curve: Address, tokens: number, minQuote: number, account: Address) {
    if (isPoolsToken(curve)) return poolsTx.sell(w, token, tokens, minQuote, account);
    const amount = parseEther(tokens.toFixed(18));
    const allowance = await publicClient.readContract({address: token, abi: tokenAbi, functionName: 'allowance', args: [account, curve]});
    if (allowance < amount) {
      const a = await w.writeContract({chain: robinhood, account, address: token, abi: tokenAbi, functionName: 'approve', args: [curve, amount]});
      await publicClient.waitForTransactionReceipt({hash: a});
    }
    const hash = await w.writeContract({
      chain: robinhood,
      account,
      address: curve,
      abi: curveAbi,
      functionName: 'sell',
      args: [amount, parseEther(Math.max(0, minQuote).toFixed(18)), account],
    });
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  /** New launches go through Uniswap's Liquidity Launcher, straight into a v4 pool. */
  launchViaPools: poolsTx.launch,

  async launch(
    w: WalletClient,
    account: Address,
    p: {name: string; symbol: string; logo: string; description: string; socials: {twitter: string; telegram: string; discord: string; website: string; farcaster: string}; creatorTaxBps: number; buybackEnabled: boolean},
  ) {
    const [expected, fee] = await Promise.all([
      publicClient.readContract({address: LAUNCH_FACTORY, abi: factoryAbi, functionName: 'previewLaunchEconomics', args: [0n, ZERO]}),
      publicClient.readContract({address: LAUNCH_FACTORY, abi: factoryAbi, functionName: 'launchFee'}),
    ]);
    const salt = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
    const hash = await w.writeContract({
      chain: robinhood,
      account,
      address: LAUNCH_FACTORY,
      abi: factoryAbi,
      functionName: 'launchToken',
      args: [
        {
          name: p.name,
          symbol: p.symbol,
          logo: p.logo,
          description: p.description,
          socials: p.socials,
          creatorFeeRecipient: account,
          creatorTaxBps: p.creatorTaxBps,
          buybackEnabled: p.buybackEnabled,
          expectedEconomics: expected,
          salt,
        },
        0n,
        ZERO,
      ],
      value: fee,
    });
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    const log = receipt.logs.find(l => l.address.toLowerCase() === LAUNCH_FACTORY.toLowerCase());
    const token = log?.topics[1] ? (`0x${log.topics[1].slice(26)}` as Address) : undefined;
    const curve = log?.topics[2] ? (`0x${log.topics[2].slice(26)}` as Address) : undefined;
    return {hash, token, curve};
  },

  async stake(w: WalletClient, account: Address, amount: number) {
    const v = parseEther(amount.toFixed(18));
    const allowance = await publicClient.readContract({address: ADDR.square, abi: erc20Abi, functionName: 'allowance', args: [account, ADDR.sink]});
    if (allowance < v) {
      const a = await w.writeContract({chain: robinhood, account, address: ADDR.square, abi: erc20Abi, functionName: 'approve', args: [ADDR.sink, v]});
      await publicClient.waitForTransactionReceipt({hash: a});
    }
    const hash = await w.writeContract({chain: robinhood, account, address: ADDR.sink, abi: sinkAbi, functionName: 'stake', args: [v]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  async unstake(w: WalletClient, account: Address, amount: number) {
    const hash = await w.writeContract({chain: robinhood, account, address: ADDR.sink, abi: sinkAbi, functionName: 'unstake', args: [parseEther(amount.toFixed(18))]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  async claim(w: WalletClient, account: Address, token: Address) {
    const hash = await w.writeContract({chain: robinhood, account, address: ADDR.sink, abi: sinkAbi, functionName: 'claim', args: [token, 50n]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  async sync(w: WalletClient, account: Address, token: Address) {
    const hash = await w.writeContract({chain: robinhood, account, address: ADDR.sink, abi: sinkAbi, functionName: 'sync', args: [token]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  /** Sell what the settler holds of `token` for ETH: half burned, half to the pool as WETH. Anyone may call. */
  async settle(w: WalletClient, account: Address, token: Address) {
    // a Pools launch pays its own settler, which sells into the token's v4 pool
    const viaPools = isPoolsToken(token) || (ADDR.pools?.tokens ?? []).some(t => t.toLowerCase() === token.toLowerCase());
    const settler = viaPools ? ADDR.pools!.settler : ADDR.settler!;
    const hash = await w.writeContract({chain: robinhood, account, address: settler, abi: settlerAbi, functionName: 'settle', args: [token, 0n]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  /** Tell the wizards fanout about `token`: makes the 20% cut claimable per wizard. Anyone may call. */
  async harvestWizards(w: WalletClient, account: Address, token: Address) {
    const hash = await w.writeContract({chain: robinhood, account, address: ADDR.wizards, abi: wizardsAbi, functionName: 'harvest', args: [token]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  async migrateDeposit(w: WalletClient, account: Address, migrate: Address, oldToken: Address, amount: number) {
    // floats round; never ask for more than the wallet actually holds
    const bal = await publicClient.readContract({address: oldToken, abi: erc20Abi, functionName: 'balanceOf', args: [account]});
    let v = parseEther(amount.toFixed(18));
    if (v > bal || amount >= f(bal) * 0.999999) v = bal;
    const allowance = await publicClient.readContract({address: oldToken, abi: erc20Abi, functionName: 'allowance', args: [account, migrate]});
    if (allowance < v) {
      const a = await w.writeContract({chain: robinhood, account, address: oldToken, abi: erc20Abi, functionName: 'approve', args: [migrate, v]});
      await publicClient.waitForTransactionReceipt({hash: a});
    }
    const hash = await w.writeContract({chain: robinhood, account, address: migrate, abi: migrateAbi, functionName: 'deposit', args: [v]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  async migrateCall(w: WalletClient, account: Address, migrate: Address, fn: 'recover' | 'claim' | 'sweep' | 'rescue') {
    const hash = await w.writeContract({chain: robinhood, account, address: migrate, abi: migrateAbi, functionName: fn, args: []});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  /** Scoop a token: one create on the factory. Terms in hours/days/bps as the form collects them. */
  async scoop(w: WalletClient, account: Address, token: Address, t: {epochHours: number; epochs: number; decayPct: number; mandate: number; sellCapPct: number; cooldownMin: number; impactPct: number; recoverDays: number; vestDays: number; claimDays: number}) {
    const p = {
      start: 0n,
      epochLength: BigInt(Math.round(t.epochHours * 3600)),
      epochs: t.epochs,
      decayBps: Math.round(t.decayPct * 100),
      mandate: parseEther(t.mandate.toFixed(18)),
      sellCapBps: Math.round(t.sellCapPct * 100),
      cooldown: BigInt(Math.round(t.cooldownMin * 60)),
      maxImpactBps: Math.round(t.impactPct * 100),
      recoverWindow: BigInt(Math.round(t.recoverDays * 86400)),
      vestLength: BigInt(Math.round(t.vestDays * 86400)),
      claimWindow: BigInt(Math.round(t.claimDays * 86400)),
    };
    const hash = await w.writeContract({chain: robinhood, account, address: ADDR.migrateFactory!, abi: migrateFactoryAbi, functionName: 'create', args: [token, p]});
    const receipt = await publicClient.waitForTransactionReceipt({hash});
    const log = receipt.logs.find(l => l.address.toLowerCase() === ADDR.migrateFactory!.toLowerCase());
    const migrate = log ? (`0x${log.topics[1]!.slice(26)}` as Address) : null;
    return {hash, migrate};
  },

  /**
   * Scoop several tokens: one approval per token that needs it (reported through `onStep`),
   * then a single batch transaction that creates takeovers where needed and deposits everything.
   */
  async batchScoop(
    w: WalletClient,
    account: Address,
    tokens: Address[],
    t: {epochHours: number; epochs: number; decayPct: number; mandate: number; sellCapPct: number; cooldownMin: number; impactPct: number; recoverDays: number; vestDays: number; claimDays: number},
    onStep: (msg: string) => void,
  ) {
    const batch = ADDR.scoopBatch!;
    const balances = await Promise.all(tokens.map(tk => publicClient.readContract({address: tk, abi: erc20Abi, functionName: 'balanceOf', args: [account]})));
    const allowances = await Promise.all(tokens.map(tk => publicClient.readContract({address: tk, abi: erc20Abi, functionName: 'allowance', args: [account, batch]})));
    let n = 0;
    const need = tokens.filter((_, i) => allowances[i] < balances[i]);
    for (const tk of need) {
      n++;
      onStep(`Approval ${n} of ${need.length}`);
      const a = await w.writeContract({chain: robinhood, account, address: tk, abi: erc20Abi, functionName: 'approve', args: [batch, balances[tokens.indexOf(tk)]]});
      await publicClient.waitForTransactionReceipt({hash: a});
    }
    onStep('Scooping');
    const p = {
      start: 0n,
      epochLength: BigInt(Math.round(t.epochHours * 3600)),
      epochs: t.epochs,
      decayBps: Math.round(t.decayPct * 100),
      mandate: parseEther(t.mandate.toFixed(18)),
      sellCapBps: Math.round(t.sellCapPct * 100),
      cooldown: BigInt(Math.round(t.cooldownMin * 60)),
      maxImpactBps: Math.round(t.impactPct * 100),
      recoverWindow: BigInt(Math.round(t.recoverDays * 86400)),
      vestLength: BigInt(Math.round(t.vestDays * 86400)),
      claimWindow: BigInt(Math.round(t.claimDays * 86400)),
    };
    const hash = await w.writeContract({chain: robinhood, account, address: batch, abi: scoopBatchAbi, functionName: 'scoop', args: [tokens, tokens.map(() => 0n), p]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },

  async migrateConvert(w: WalletClient, account: Address, migrate: Address) {
    const hash = await w.writeContract({chain: robinhood, account, address: migrate, abi: migrateAbi, functionName: 'convert', args: [0n]});
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  },
};
