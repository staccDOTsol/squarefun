// Keeper for Contagian tokens launched through the first launcher: does the vault's chores so
// nobody has to press a button. Every chore is open to anyone and safe to repeat; this just calls
// them when a dry run says there is something to do.
//
//   KEEPER_KEY=0x…  bun keeper/contagian-keeper.mjs        (KEEPER_RPC, KEEPER_EVERY seconds optional)
//
// offer    once an hour, when the vault holds tolls
// settle   when the price is over parity and there are tolls to sell
// deepen   each partner, once an hour (the first call for a partner only takes a reading)
// harvest  ranges that have something to collect
// activate entries in the directory whose hour is up
import { createPublicClient, createWalletClient, http, parseAbi } from '../app/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '../app/node_modules/viem/_esm/accounts/index.js'

const RPC = process.env.KEEPER_RPC ?? 'https://rpc.mainnet.chain.robinhood.com'
const LAUNCHER = process.env.CONTAGIAN_LAUNCHER ?? '0x62924A07935B49b487162b9aabcf7a9C35fc8531'
const EVERY = Number(process.env.KEEPER_EVERY ?? 60) * 1000
const key = process.env.KEEPER_KEY
if (!key) throw new Error('KEEPER_KEY is not set')

const chain = { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
const pub = createPublicClient({ chain, transport: http(RPC) })
const wallet = createWalletClient({ chain, account, transport: http(RPC) })

const launcherAbi = parseAbi([
  'function count() view returns (uint256)',
  'function launches(uint256) view returns (address token, address vault, address creator, address quote, address peg, int24 openTick, int24 ceilingTick, uint64 launchedAt)',
])
const vaultAbi = parseAbi([
  'function tolls() view returns (uint256)',
  'function spot() view returns (uint256)',
  'function parity() view returns (uint256)',
  'function partnerCount() view returns (uint256)',
  'function rangeCount() view returns (uint256)',
  'function pendingBy(address) view returns (uint256)',
  'function maturesAt(address) view returns (uint256)',
  'function offer() returns (uint256)',
  'function settle() returns (uint256, uint256)',
  'function deepen(uint256) returns (uint256)',
  'function harvest(uint256, uint256) returns (uint256, uint256)',
  'function activate(address)',
  'event Paid(address indexed originator, uint256 tolls, uint256 worth)',
])

const log = (...a) => console.log(new Date().toISOString(), ...a)
const payers = new Map() // vault -> Set of originators seen in Paid
const cursor = new Map() // vault -> next block to read Paid from

/** Send only if a dry run says the call does something. */
async function maybe(vault, functionName, args, worth) {
  let result
  try {
    ;({ result } = await pub.simulateContract({ account, address: vault, abi: vaultAbi, functionName, args }))
  } catch {
    return false
  }
  if (!worth(result)) return false
  const hash = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName, args })
  const r = await pub.waitForTransactionReceipt({ hash })
  log(`${functionName}(${args.join(',')}) on ${vault}: ${r.status} ${hash}`)
  return r.status === 'success'
}

async function tend({ vault, launchedAt }, head) {
  const read = (functionName, args = []) => pub.readContract({ address: vault, abi: vaultAbi, functionName, args })
  const [tolls, spot, parity, partners, ranges] = await Promise.all([read('tolls'), read('spot'), read('parity'), read('partnerCount'), read('rangeCount')])

  // what offers already sold for, and what they earned
  if (ranges > 0n) await maybe(vault, 'harvest', [0n, ranges], ([proceeds, fees]) => proceeds > 0n || fees > 0n)
  if (tolls > 0n) {
    await maybe(vault, 'offer', [], (placed) => placed > 0n)
    if (spot > parity) await maybe(vault, 'settle', [], ([sold]) => sold > 0n)
  }
  // a partner's first call only takes a reading, which a dry run cannot tell from nothing: so
  // each partner is called once an hour whether or not the dry run reports a placement
  for (let i = 0n; i < partners; i++) {
    const k = `${vault}:${i}`
    if ((tend.deepened.get(k) ?? 0) + 3_600_000 > Date.now()) continue
    tend.deepened.set(k, Date.now())
    if (tolls > 0n) await maybe(vault, 'deepen', [i], () => true)
  }

  // entries whose hour is up
  const from = cursor.get(vault) ?? head - 90_000n
  const logs = await pub.getLogs({ address: vault, event: vaultAbi.find((x) => x.name === 'Paid'), fromBlock: from > 0n ? from : 0n, toBlock: head }).catch(() => [])
  cursor.set(vault, head + 1n)
  const set = payers.get(vault) ?? new Set()
  payers.set(vault, set)
  for (const l of logs) set.add(l.args.originator)
  const now = BigInt(Math.floor(Date.now() / 1000))
  for (const who of set) {
    const [waiting, at] = await Promise.all([read('pendingBy', [who]), read('maturesAt', [who])])
    if (waiting > 0n && at <= now) await maybe(vault, 'activate', [who], () => true)
  }
  void launchedAt
}
tend.deepened = new Map()

async function tick() {
  const head = await pub.getBlockNumber()
  const n = await pub.readContract({ address: LAUNCHER, abi: launcherAbi, functionName: 'count' })
  for (let i = 0n; i < n; i++) {
    const [token, vault, , , , , , launchedAt] = await pub.readContract({ address: LAUNCHER, abi: launcherAbi, functionName: 'launches', args: [i] })
    try {
      await tend({ token, vault, launchedAt }, head)
    } catch (e) {
      log(`vault ${vault}: ${e.shortMessage ?? e.message}`)
    }
  }
}

log(`contagian keeper ${account.address} on ${RPC}, launcher ${LAUNCHER}, every ${EVERY / 1000}s`)
if (process.env.KEEPER_ONCE) {
  await tick()
} else {
  for (;;) {
    await tick().catch((e) => log('tick failed:', e.shortMessage ?? e.message))
    await new Promise((r) => setTimeout(r, EVERY))
  }
}
