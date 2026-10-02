// Adversarial run against a Contagian token launched through the real Pools launcher, on an anvil
// fork of Robinhood Chain. Real transactions: real tx.origin, transient storage cleared per
// transaction, several transactions per block where the attack needs it.
//
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8546 --auto-impersonate
//   forge build && bun test/adversarial/attack.mjs
import { readFileSync } from 'node:fs'
import {
  createTestClient, http, publicActions, walletActions, parseAbi, encodeAbiParameters, encodeFunctionData,
  keccak256, pad, toHex, parseEther, parseEventLogs, getContractAddress,
} from '../../app/node_modules/viem/_esm/index.js'

const RPC = process.env.ANVIL ?? 'http://127.0.0.1:8546'
const LAUNCHER = '0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0'
const MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const ARB_SYS = '0x0000000000000000000000000000000000000064'
const WIZARDS = '0x1b88A6c6516FD2918905186F21Bb9F5CaA1a15c8'
const STAKE_POOL = '0x78CD5692961cd0dc9bC15327BF34cDc1bCdca41C'
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
const ETH = '0x0000000000000000000000000000000000000000'
const SUPPLY = 1_000_000_000n * 10n ** 18n
const USD = 10n ** 6n
const TOK = 10n ** 18n

const chain = { id: 4663, name: 'rh-fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }
const c = createTestClient({ mode: 'anvil', chain, transport: http(RPC, { timeout: 120_000 }) }).extend(publicActions).extend(walletActions)

const art = (file, name) => JSON.parse(readFileSync(new URL(`../../out/${file}/${name}.json`, import.meta.url)))
const A = {
  strategy: art('ContagianLaunchStrategy.sol', 'ContagianLaunchStrategy'),
  vault: art('ContagianVault.sol', 'ContagianVault'),
  launcher: art('ContagianLauncher.sol', 'ContagianLauncher'),
  factory: art('ContagianToken.sol', 'ContagianTokenFactory'),
  token: art('ContagianToken.sol', 'ContagianToken'),
  router: art('Attackers.sol', 'Router'),
  dollar: art('Attackers.sol', 'Dollar'),
}
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)', 'function totalSupply() view returns (uint256)',
])
const launcherAbi = parseAbi([
  'function createToken(address factory,string name,string symbol,uint8 decimals,uint128 initialSupply,address recipient,bytes tokenData) returns (address)',
  'function distributeToken(address token,(address strategy,uint128 amount,bytes configData) distribution,bytes32 salt)',
  'function multicall(bytes[] data) returns (bytes[])',
  'function getGraffiti(address) pure returns (bytes32)',
])
const stateView = parseAbi(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)'])
const managerAbi = parseAbi(['function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint160 sqrtPriceX96) returns (int24)'])

// ─── plumbing ────────────────────────────────────────────────────────────────
const who = (n) => pad(toHex(0xA11CE000 + n), { size: 20 })
const DEPLOYER = who(0)
let ts
const usd = (x) => (Number(x) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 4 })
const tok = (x) => (Number(x) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 })
const px = (spot) => Number(spot) / 1e24
const pct = (wad) => (Number(wad) / 1e16).toFixed(4) + '%'
const findings = []
const say = (...a) => console.log(...a)
const head = (t) => say(`\n━━ ${t} ${'━'.repeat(Math.max(0, 76 - t.length))}`)
const verdict = (name, held, detail) => { findings.push({ name, held, detail }); say(`  ${held ? 'HELD  ' : 'BROKE '} ${detail}`) }

async function fund(addr, usdg) {
  await c.setBalance({ address: addr, value: parseEther('1000') })
  if (usdg) {
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, 1n]))
    await c.setStorageAt({ address: USDG, index: slot, value: pad(toHex(usdg), { size: 32 }) })
  }
}
let order = 0
async function send(from, to, abi, functionName, args = [], gas = 6_000_000n) {
  // descending tips keep the order they were sent in inside one block
  const tip = 5_000_000_000n - BigInt(order++) * 1_000_000n
  return c.sendTransaction({ account: from, to, data: encodeFunctionData({ abi, functionName, args }), gas, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: tip })
}
/** Mine everything queued into one block, `dt` seconds after the last one. */
async function block(dt = 1, hashes = []) {
  ts += BigInt(dt)
  await c.setNextBlockTimestamp({ timestamp: ts })
  await c.mine({ blocks: 1 })
  order = 0
  return Promise.all(hashes.map((hash) => c.getTransactionReceipt({ hash })))
}
/** One transaction in its own block. */
async function tx(from, to, abi, fn, args, dt = 1) {
  const [r] = await block(dt, [await send(from, to, abi, fn, args)])
  return r
}
const read = (address, abi, functionName, args = []) => c.readContract({ address, abi, functionName, args })

// ─── the system under test ───────────────────────────────────────────────────
const S = {}
async function deploy(a, args) {
  const hash = await c.deployContract({ account: DEPLOYER, abi: a.abi, bytecode: a.bytecode.object, args, gas: 12_000_000n })
  const [r] = await block(1, [hash])
  if (r.status !== 'success') throw new Error('deploy failed')
  return r.contractAddress
}
/** Returns the launch transaction unmined, so a test can put a sniper in the same block. */
async function prepareLaunch() {
  S.strategy = await deploy(A.strategy, [MANAGER, LAUNCHER])
  S.vaultImpl = await deploy(A.vault, [MANAGER, S.strategy, WIZARDS, STAKE_POOL, WETH])
  S.launcher = await deploy(A.launcher, [LAUNCHER, MANAGER, S.strategy, S.vaultImpl])
  S.factory = await read(S.launcher, A.launcher.abi, 'tokenFactory')
  S.usdx = await deploy(A.dollar, []) // another dollar, 18 decimals where USDG has 6
  S.router = await deploy(A.router, [MANAGER])
  // the vault is the launcher's next creation (its first was the token factory), so the token is knowable
  S.vault = getContractAddress({ from: S.launcher, nonce: 2n })
  const metadata = ['a memecoin whose moon is parity', 'https://squarefun.xyz', '', 0n]
  const data = encodeAbiParameters(
    [{ type: 'tuple', components: [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }] }, { type: 'address' }],
    [metadata, S.vault],
  )
  S.token = await read(S.factory, A.factory.abi, 'getTokenAddress', ['Contagian', 'CONTAGIAN', SUPPLY, LAUNCHER, data])
  // quote-per-token ticks: parity is one USDG (6 decimals) per token (18) at tick -276,324; the pool
  // opens 118,850 ticks under it and the supply runs on past it to the edge
  const params = {
    name: 'Contagian', symbol: 'CONTAGIAN',
    metadata: { description: metadata[0], website: metadata[1], image: '', xProofTweetId: 0n },
    quote: USDG, peg: { asset: USDG, refFee: 0, refSpacing: 0 }, openTick: -276_325 - 118_850, ceilingTick: 887_250,
    partners: [{ asset: S.usdx, refFee: 0, refSpacing: 0 }, { asset: ETH, refFee: 100, refSpacing: 1 }],
  }
  return () => send(DEPLOYER, S.launcher, A.launcher.abi, 'launch', [params], 20_000_000n)
}
async function actor(n, usdg = 10_000_000n * USD) {
  const a = who(n)
  await fund(a, usdg)
  const hs = [await send(a, USDG, erc20, 'approve', [S.router, 2n ** 256n - 1n])]
  if (S.live) hs.push(await send(a, S.token, erc20, 'approve', [S.router, 2n ** 256n - 1n]))
  await block(1, hs)
  return a
}
const buy = (from, usdg, quote = USDG) => send(from, S.router, A.router.abi, 'buy', [S.token, quote, usdg, from])
const sell = (from, amount, quote = USDG) => send(from, S.router, A.router.abi, 'sell', [S.token, quote, amount])
const bal = (a) => read(S.token, erc20, 'balanceOf', [a])
const usdgOf = (a) => read(USDG, erc20, 'balanceOf', [a])
async function state() {
  const V = (fn) => read(S.vault, A.vault.abi, fn)
  const [spot, parity, circ, e, tax, tolls] = await Promise.all([V('spot'), V('parity'), V('circulating'), V('engine'), V('taxBps'), V('tolls')])
  return { spot, parity, circ, e, buyBps: tax[0], sellBps: tax[1], tolls }
}
async function rawPoolPrice() {
  const id = await read(S.vault, A.vault.abi, 'poolId')
  const [sqrtP, tick] = await read(STATE_VIEW, stateView, 'getSlot0', [id])
  return { sqrtP, tick }
}
const show = (s, label = '') => say(`  ${label.padEnd(26)} price $${px(s.spot).toPrecision(4)} (avg ${px(s.e.price).toPrecision(4)}), ${(px(s.spot) / px(s.parity) * 100).toPrecision(3)}% of parity  holders ${tok(s.circ)}  tolls ${tok(s.tolls)}  lagging tax buy/sell ${s.buyBps}/${s.sellBps} bp`)
const ev = (r, name) => parseEventLogs({ abi: A.vault.abi, logs: r.logs, eventName: name }).map((l) => l.args)
const V = (fn, args = []) => read(S.vault, A.vault.abi, fn, args)
const approveRouter = async (...ws) => block(1, await Promise.all(ws.map((w) => send(w, S.token, erc20, 'approve', [S.router, 2n ** 256n - 1n]))))
/** One trade in its own block; what it cost in tolls, tokens and USDG. */
async function trade(w, kind, amount, dt = 30, quote = USDG) {
  const [t0, u0, v0] = [await bal(w), await usdgOf(w), await bal(S.vault)]
  const [r] = await block(dt, [kind === 'buy' ? await buy(w, amount, quote) : await sell(w, amount, quote)])
  const [t1, u1, v1] = [await bal(w), await usdgOf(w), await bal(S.vault)]
  const tax = v1 - v0
  const size = kind === 'buy' ? (t1 - t0) + tax : amount
  return { status: r.status, r, tax, pct: size === 0n ? 0 : Number(tax * 10000n / size) / 100, tokens: kind === 'buy' ? t1 - t0 : t0 - t1, usdg: kind === 'buy' ? u0 - u1 : u1 - u0 }
}
const rest = async (hours = 4) => { for (let i = 0; i < hours / 2; i++) await block(7200, [await send(DEPLOYER, S.vault, A.vault.abi, 'poke', [])]) }

const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null
/** Why a mined transaction reverted: replay it against the block before. */
async function why(r) {
  const t = await c.getTransaction({ hash: r.transactionHash })
  try { await c.call({ account: t.from, to: t.to, data: t.input, value: t.value, blockNumber: r.blockNumber - 1n }); return 'no revert on replay' } catch (e) { return (e.shortMessage ?? e.message).slice(0, 300) }
}
async function scenario(title, fn) {
  if (ONLY && !ONLY.includes(title.split('.')[0])) return
  head(title)
  const id = await c.snapshot()
  const t0 = ts
  try { await fn() } catch (e) { verdict(title, false, `scenario threw: ${e.shortMessage ?? e.message}`) }
  await c.revert({ id })
  ts = t0
}

// ─── run ─────────────────────────────────────────────────────────────────────
await c.setCode({ address: ARB_SYS, bytecode: '0x435f5260205ff3' }) // arbBlockNumber() -> block.number
await c.setAutomine(false)
ts = (await c.getBlock()).timestamp
await fund(DEPLOYER, 0n)

head('0. Launch through the Contagian launcher, with a sniper in the same block')
{
  const launch = await prepareLaunch()
  const sniper = await actor(1)
  const before = await usdgOf(sniper)
  const [l, sn] = await block(1, [await launch(), await buy(sniper, 5_000n * USD)])
  if (l.status !== 'success') throw new Error('launch reverted')
  const made = await read(S.launcher, A.launcher.abi, 'launches', [0n])
  if (made[0].toLowerCase() !== S.token.toLowerCase() || made[1].toLowerCase() !== S.vault.toLowerCase()) throw new Error('launch is not where it was predicted')
  S.live = true
  const got = await bal(sniper)
  const st = await state()
  show(st, 'after launch + snipe')
  say(`  launch gas ${l.gasUsed}; sniper ${sn.status}: $${usd(before - (await usdgOf(sniper)))} bought ${tok(got)} tokens (${(Number(got) / 1e25).toFixed(2)}% of supply), toll ${tok(st.tolls)}`)
  verdict('rule: below, buyers do not pay', st.tolls < TOK, 'a buy under parity pays no tax, in the launch block or any other. That is the rule as stated; it also means a launch sniper gets in free')
  await approveRouter(sniper)
  const back = await trade(sniper, 'sell', got, 2)
  say(`  the sniper sells it all straight back: ${back.status}, $${usd(back.usdg)} out, ${tok(back.tax)} tax`)
  await rest()
  show(await state(), 'four hours later')
}

const alice = await actor(2), bob = await actor(3), carol = await actor(4), mallory = await actor(5)

await scenario('1. Below the peg: buying is free, dumping pays', async () => {
  const buys = [await trade(alice, 'buy', 2_000n * USD, 600), await trade(bob, 'buy', 2_000n * USD, 600), await trade(mallory, 'buy', 2_000n * USD, 600)]
  say(`  three $2,000 buys ten minutes apart: tax ${buys.map((b) => tok(b.tax)).join(' / ')} tokens; got ${buys.map((b) => tok(b.tokens)).join(' / ')}`)
  await rest()
  show(await state(), 'at rest')
  await approveRouter(alice, bob, mallory)
  const a = await trade(alice, 'sell', (await bal(alice)) / 10n)
  say(`  alice sells a tenth at rest: ${a.status}, ${tok(a.tax)} tax on top (${a.pct}%), $${usd(a.usdg)} out`)
  const b = await trade(bob, 'sell', (await bal(bob)) / 2n)
  say(`  bob dumps half his bag: ${b.status}, ${tok(b.tax)} tax on top (${b.pct}%), $${usd(b.usdg)} out`)
  show(await state(), 'after the dump')
  const all = await bal(mallory)
  const m = await trade(mallory, 'sell', all, 5)
  const part = await trade(mallory, 'sell', (all * 6n) / 10n, 5)
  say(`  mallory sells her whole balance into the dump: ${m.status}; 60% of it instead: ${part.status}, ${tok(part.tax)} tax on top (${part.pct}%)`)
  const c1 = await trade(carol, 'buy', 3_000n * USD, 5)
  say(`  carol buys the dip with $3,000: ${c1.status}, ${tok(c1.tax)} tax`)
  verdict('below: buyers free', buys.every((x) => x.tax === 0n) && c1.tax === 0n, 'under parity a buy pays nothing, at rest or into a dump')
  verdict('below: sellers pay', a.status === 'success' && b.status === 'success' && b.pct > a.pct && b.pct > 1,
    `under parity a sale pays for the push, out of what the seller has left: ${a.pct}% on a small one, ${b.pct}% on a dump`)
  verdict('sell-all under tax', m.status === 'reverted' && part.status === 'success', 'while the sell tax is on, a whole balance cannot be sold: the tax has to be left behind. A partial sale goes through')
})

/** Holders, a dump that leaves tolls in the vault, and an hour for the dumper's entry to count. */
async function withTolls() {
  await trade(alice, 'buy', 2_000n * USD, 600)
  await trade(bob, 'buy', 6_000n * USD, 600)
  await rest()
  await approveRouter(alice, bob)
  const dump = await trade(bob, 'sell', (await bal(bob)) / 2n)
  await rest()
  await block(1, [await send(carol, S.vault, A.vault.abi, 'activate', [bob])])
  return dump
}

await scenario('2. The tolls are sold on the way up, never down; half to the bad beats, half to the holders', async () => {
  const dump = await withTolls()
  const before = await state()
  say(`  bob's dump paid ${tok(dump.tax)} tokens of tax (${dump.pct}%); his entry in the directory: $${usd(await V('paidBy', [bob]))} earning`)
  const [o] = await block(1, [await send(carol, S.vault, A.vault.abi, 'offer', [])])
  const off = ev(o, 'Offered')[0]
  const after = await state()
  const again = await block(1, [await send(carol, S.vault, A.vault.abi, 'offer', []), await send(carol, S.vault, A.vault.abi, 'offer', [])])
  say(`  offer ${o.status}: ${tok(off.tolls)} tolls on sale over the price (ticks ${off.lower}..${off.upper}); price before $${px(before.spot).toPrecision(6)}, after $${px(after.spot).toPrecision(6)}; twice more: tolls ${tok((await state()).tolls)} (unchanged ${(await state()).tolls === after.tolls})`)
  verdict('offer is price-neutral', o.status === 'success' && off.tolls > 0n && after.spot === before.spot && (await state()).tolls === after.tolls && again.every((r) => r.status === 'success'),
    'a tranche of tolls goes on sale above the price without moving it, once a period')
  // buyers take the price up through the offer
  await trade(carol, 'buy', 40_000n * USD, 60)
  show(await state(), 'bought up through it')
  const [aBal, bBal, cBal] = [await bal(alice), await bal(bob), await bal(carol)]
  const [h] = await block(5, [await send(mallory, S.vault, A.vault.abi, 'harvest', [0n, 10n])])
  const hv = ev(h, 'Harvested')[0], rf = ev(h, 'Reflected')[0]
  say(`  harvest ${h.status}: the offer sold for $${usd(hv.otherAmount)} (sold ${hv.sold}); reflected $${usd(rf.toPayers)} to the bad beats, $${usd(rf.toHolders)} to the holders`)
  await block(3_700, [await send(DEPLOYER, S.vault, A.vault.abi, 'poke', [])])
  const cl = {}
  for (const [n, w] of [['alice', alice], ['bob', bob], ['carol', carol]]) cl[n] = await V('claimable', [w])
  say(`  an hour later, claimable as bad beat / as holder: alice $${usd(cl.alice[0])} / $${usd(cl.alice[1])}; bob $${usd(cl.bob[0])} / $${usd(cl.bob[1])}; carol $${usd(cl.carol[0])} / $${usd(cl.carol[1])}`)
  say(`  balances then: alice ${tok(aBal)}, bob ${tok(bBal)}, carol ${tok(cBal)}; pool manager and vault are owed $${usd((await V('claimable', [MANAGER]))[1])} / $${usd((await V('claimable', [S.vault]))[1])}`)
  const u0 = await usdgOf(bob)
  const [c1] = await block(1, [await send(bob, S.vault, A.vault.abi, 'claim', [])])
  const got = (await usdgOf(bob)) - u0
  // the launch-block sniper could not sell out, so is a holder too
  const holderSum = cl.alice[1] + cl.bob[1] + cl.carol[1] + (await V('claimable', [who(1)]))[1] + (await V('claimable', [mallory]))[1]
  say(`  bob claims: ${c1.status}, $${usd(got)} in USDG; holders together were owed $${usd(holderSum)} of the $${usd(rf.toHolders)} reflected to them`)
  verdict('reflection split', rf.toPayers > 0n && rf.toHolders >= rf.toPayers - 1n && rf.toHolders <= rf.toPayers + 1n, 'what the tolls sold for is split half to the bad beats and half to the holders')
  verdict('bad beats paid', cl.bob[0] > (rf.toPayers * 90n) / 100n && cl.carol[0] === 0n && got === cl.bob[0] + cl.bob[1], `bob, who paid the tax an hour before, is owed the bad beats' half; carol, who paid none, is owed none of it; bob collected $${usd(got)}`)
  verdict('holders paid by balance', holderSum <= rf.toHolders && holderSum > (rf.toHolders * 95n) / 100n && cl.carol[1] > cl.alice[1] && (await V('claimable', [MANAGER]))[1] === 0n,
    'the holders\' half is shared by balance among wallets that hold the token; the pool and the vault are owed nothing')
})

await scenario('3. Over the peg: buyers pay, sellers do not, and the tolls are sold down to it', async () => {
  const whale = await actor(60, 20_000_000n * USD)
  const up = []
  for (const q of [100_000n, 1_000_000n, 1_500_000n]) { up.push(await trade(whale, 'buy', q * USD, 600)); show(await state(), `bought $${q.toLocaleString()}`) }
  say(`  on the way up under parity the whale paid ${up.map((x) => x.pct + '%').join(' / ')}`)
  const over = await trade(whale, 'buy', 200_000n * USD, 600)
  show(await state(), 'bought $200,000 more')
  say(`  the buy that takes it over parity: ${over.status}, ${over.pct}% tax (${tok(over.tax)} tokens)`)
  const chaser = await trade(bob, 'buy', 20_000n * USD, 60)
  say(`  bob chases it over parity with $20,000: ${chaser.status}, ${chaser.pct}% tax`)
  await approveRouter(whale, bob)
  const out = await trade(bob, 'sell', (await bal(bob)) / 2n, 60)
  say(`  bob sells half back while it is over parity: ${out.status}, ${tok(out.tax)} tax`)
  const before = await state()
  const [r] = await block(30, [await send(carol, S.vault, A.vault.abi, 'settle', [])])
  const sv = ev(r, 'Settled')[0], rf = ev(r, 'Reflected')[0]
  const after = await state()
  show(before, 'before settle'); show(after, 'after settle')
  say(`  settle ${r.status}: sold ${sv ? tok(sv.tolls) : 0} tolls for $${sv ? usd(sv.quoteIn) : 0}; reflected $${rf ? usd(rf.toPayers) : 0} / $${rf ? usd(rf.toHolders) : 0}; tip $${sv ? usd(sv.tip) : 0}`)
  const [r2] = await block(30, [await send(carol, S.vault, A.vault.abi, 'settle', [])])
  verdict('below: buyers free (large)', up.every((x) => x.tax === 0n), 'under parity even a seven-figure buy pays nothing')
  verdict('above: buyers pay', over.tax > 0n && chaser.pct > 5, `over parity a buy pays for the push: ${over.pct}% on the one that crossed it, ${chaser.pct}% on the one that chased it`)
  verdict('above: sellers free', out.status === 'success' && out.tax === 0n, 'over parity a sale pays nothing')
  verdict('settle stops at parity', !!sv && after.spot >= after.parity && after.spot < before.spot && ev(r2, 'Settled').length === 0,
    'over parity the vault sells tolls down toward the peg and no further; calling again sells nothing')
})

await scenario('4. Ten wallets in one block', async () => {
  const crew = []
  for (let i = 0; i < 10; i++) crew.push(await actor(20 + i, 10_000n * USD))
  const v0 = await bal(S.vault)
  const hs = []
  for (const w of crew) hs.push(await buy(w, 100n * USD))
  await block(60, hs)
  const got = await Promise.all(crew.map(bal))
  const tolls = (await bal(S.vault)) - v0
  say(`  per wallet: ${got.map((g, i) => `${i + 1}:${tok(g)}`).join('  ')}`)
  say(`  the crew paid ${tok(tolls)} tokens in tolls on $1,000 of buys under parity`)
  verdict('machines pay anywhere', tolls > 0n && got[9] < got[2], 'the k-th transfer of a block pays 10 bp x k^2 whatever side of parity it is on: buying is only free for people who are not a crowd')
})

await scenario('5. A sale third in its block', async () => {
  await trade(alice, 'buy', 500n * USD, 60)
  await trade(mallory, 'buy', 500n * USD, 60)
  await rest()
  const hop1 = who(90), hop2 = who(91)
  await fund(hop1, 0n); await fund(hop2, 0n)
  const min = (await read(S.token, erc20, 'totalSupply')) / 10_000n
  await block(600, [await send(mallory, S.token, erc20, 'transfer', [hop1, min * 4n])])
  await block(600, [await send(mallory, S.token, erc20, 'transfer', [hop2, min * 4n])])
  await approveRouter(alice)
  const u0 = await usdgOf(alice), has = await bal(alice)
  const [h1, h2, sale] = await block(1, [
    await send(hop1, S.token, erc20, 'transfer', [who(92), min]),
    await send(hop2, S.token, erc20, 'transfer', [who(93), min]),
    await sell(alice, has / 4n),
  ])
  say(`  block: hop ${h1.status}, hop ${h2.status}, then alice's sale as the block's third transfer: ${sale.status}, $${usd((await usdgOf(alice)) - u0)} out`)
  verdict('sell freeze', sale.status === 'success', 'other people\'s transfers ahead of a sale in its block cannot revert it')
})

await scenario('6. Buy and sell inside one unlock: the token never moves', async () => {
  await trade(alice, 'buy', 200n * USD, 60)
  await rest()
  const before = await state(), u0 = await usdgOf(mallory)
  const [r] = await block(1, [await send(mallory, S.router, A.router.abi, 'inAndOut', [S.token, USDG, 50_000n * USD])])
  const after = await state()
  say(`  tx ${r.status}; attacker cost $${usd(u0 - (await usdgOf(mallory)))}; tolls before ${tok(before.tolls)} after ${tok(after.tolls)}`)
  verdict('netted round trip', after.tolls > before.tolls, 'a $50,000 round trip netted inside one v4 unlock makes no token transfer: no toll, no count, no sample. Only the 0.25% LP fee. Only a hook could see it')
})

await scenario('7. A gift to the vault, and holders who come and go', async () => {
  await trade(alice, 'buy', 1_000n * USD, 60)
  await trade(mallory, 'buy', 1_000n * USD, 60)
  const gift = (await bal(mallory)) / 2n
  const [g] = await block(60, [await send(mallory, S.token, erc20, 'transfer', [S.vault, gift])])
  const [t] = await block(60, [await send(mallory, S.token, erc20, 'transfer', [carol, (await bal(mallory)) / 2n])])
  const [t2] = await block(60, [await send(carol, S.token, erc20, 'transfer', [alice, await bal(carol)])])
  await approveRouter(alice)
  const s1 = await trade(alice, 'sell', (await bal(alice)) / 20n, 600)
  const [c1] = await block(1, [await send(mallory, S.vault, A.vault.abi, 'claim', [])])
  say(`  gift ${g.status} (${tok(gift)} tokens join the tolls), transfers ${t.status}/${t2.status}, a sale ${s1.status}, a claim with nothing owed ${c1.status}`)
  verdict('holder bookkeeping', [g, t, t2, c1].every((r) => r.status === 'success') && s1.status === 'success', 'gifts to the vault, wallet-to-wallet moves and empty claims leave the holder accounts consistent')
})

await scenario('13. A partner dollar: a griefed pool, asks at the launch price, and a partner that dies', async () => {
  const dave = who(80); await fund(dave, 0n)
  const mint = (to, n) => send(DEPLOYER, S.usdx, A.dollar.abi, 'mint', [to, n])
  await block(1, [await mint(dave, 1_000n * TOK), await mint(mallory, 10n ** 12n * TOK)])
  await block(1, [await send(dave, S.usdx, erc20, 'approve', [S.router, 2n ** 256n - 1n]), await send(mallory, S.usdx, erc20, 'approve', [S.router, 2n ** 256n - 1n])])
  await withTolls()
  const before = await state()
  const t0 = BigInt(S.token) < BigInt(S.usdx)
  const key = { currency0: t0 ? S.token : S.usdx, currency1: t0 ? S.usdx : S.token, fee: 2500, tickSpacing: 25, hooks: ETH }
  const wrong = t0 ? 79228162514264337593543950336n * 1000n : 79228162514264337593543950336n / 1000n
  const [g] = await block(1, [await send(mallory, MANAGER, managerAbi, 'initialize', [key, wrong])])
  const [look] = await block(1, [await send(carol, S.vault, A.vault.abi, 'deepen', [0n])])
  const looked = (await state()).tolls === before.tolls
  const [d1] = await block(3700, [await send(carol, S.vault, A.vault.abi, 'deepen', [0n])])
  const mid = await state()
  const placed = before.tolls - mid.tolls
  await block(1, [await send(carol, S.vault, A.vault.abi, 'deepen', [0n]), await send(carol, S.vault, A.vault.abi, 'deepen', [0n])])
  const same = (await state()).tolls === mid.tolls
  say(`  griefer's initialize ${g.status}; first deepen ${look.status} only takes a reading (${looked}); an hour later deepen ${d1.status}: ${tok(placed)} tolls on offer against USDX; two more calls leave tolls unchanged: ${same}`)
  verdict('partner asks', d1.status === 'success' && looked && placed > 0n && same, 'a pool someone else opened at the wrong price is carried back for one unit of token; a tranche goes on offer once a period, and calling again adds nothing')
  const snap = await c.snapshot(), tsnap = ts
  const viaUsdg = (await trade(carol, 'buy', 100n * USD, 60)).tokens
  await c.revert({ id: snap }); ts = tsnap
  const d0 = await bal(dave)
  await block(60, [await buy(dave, 100n * TOK, S.usdx)])
  const viaUsdx = (await bal(dave)) - d0
  say(`  $100 of USDG buys ${tok(viaUsdg)}; $100 of USDX buys ${tok(viaUsdx)}`)
  verdict('partner price', viaUsdx > 0n && viaUsdx <= viaUsdg, 'the partner pool never sells cheaper than the launch pool')
  const [k] = await block(60, [await buy(mallory, 10n ** 11n * TOK, S.usdx)])
  const tolls0 = (await state()).tolls
  const [d2] = await block(3700, [await send(carol, S.vault, A.vault.abi, 'deepen', [0n])])
  const tolls1 = (await state()).tolls
  say(`  the partner dies: someone buys every ask with a worthless trillion of it (${k.status}); an hour later deepen ${d2.status}, tolls offered: ${tok(tolls0 - tolls1)}`)
  verdict('dead partner', tolls0 - tolls1 < 10n, `once the partner pool prices the token over the launch pool nothing more is offered: the loss is what was on offer (${tok(placed)} tokens)`)
})

await scenario('14. ETH as a partner: single-sided asks, and a pushed reference price', async () => {
  await withTolls()
  await block(1, [await send(carol, S.vault, A.vault.abi, 'deepen', [1n])])
  const id = await c.snapshot(), t0 = ts
  const [h] = await block(3700, [await send(carol, S.vault, A.vault.abi, 'deepen', [1n])])
  const honest = ev(h, 'Offered')[0]
  const vaultEth = await c.getBalance({ address: S.vault })
  const a0 = await bal(alice)
  const hash = await c.sendTransaction({ account: alice, to: S.router, data: encodeFunctionData({ abi: A.router.abi, functionName: 'buy', args: [S.token, ETH, parseEther('0.05'), alice] }), value: parseEther('0.05'), gas: 6_000_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 5_000_000_000n })
  const [b] = await block(60, [hash])
  const viaEth = (await bal(alice)) - a0
  say(`  deepen ${h.status}: ${tok(honest.tolls)} tolls on offer against ETH, ticks ${honest.lower}..${honest.upper}; the vault put up no ETH (holds ${vaultEth} wei); a buy with 0.05 ETH ${b.status}, got ${tok(viaEth)} tokens`)
  await c.revert({ id }); ts = t0
  const [pump, d] = await block(3700, [
    await send(mallory, S.router, A.router.abi, 'swapIn', [ETH, USDG, 100, 1, false, 300_000n * USD], 60_000_000n),
    await send(carol, S.vault, A.vault.abi, 'deepen', [1n]),
  ])
  const pushed = ev(d, 'Offered')[0]
  say(`  with $300,000 pushed through the ETH/USDG pool first (${pump.status}${pump.status === 'success' ? '' : ': ' + (await why(pump))}): deepen ${d.status}, ticks ${pushed ? `${pushed.lower}..${pushed.upper}` : 'none placed'} against ${honest.lower}..${honest.upper} unpushed`)
  verdict('eth partner', honest.tolls > 0n && viaEth > 0n && vaultEth === 0n, 'tolls go on offer against ETH with none of the vault\'s own ETH at risk, and they sell for ETH')
  verdict('pushed reference', pump.status === 'success' && (!pushed || (pushed.lower === honest.lower && pushed.upper === honest.upper)), pump.status === 'success' ? 'a reference price pushed for one block is not used: the offer sits where the earlier reading put it' : 'the push itself failed, so this proves nothing')
})

head('Summary')
for (const f of findings) say(`  ${f.held ? 'HELD ' : 'BROKE'}  ${f.name.padEnd(22)} ${f.detail}`)
