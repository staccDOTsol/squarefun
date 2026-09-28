import {useCallback, useEffect, useState} from 'react';
import type {Address} from 'viem';
import {Button} from '../components/ui/Button';
import {Input} from '../components/ui/Field';
import {Badge, Empty, ErrorBox, Progress, Skeleton, toast} from '../components/ui/Bits';
import {BRAND} from '../lib/brand';
import {ADDR, batchDeployed, robinhood, scooperDeployed} from '../lib/chain';
import {data, tx} from '../lib/data';
import {eth, num, pct, short} from '../lib/format';
import {useLive} from '../lib/live';
import {Link, useRouter} from '../lib/router';
import type {Migration, MigrationStage, WalletToken} from '../lib/types';
import {useWallet} from '../lib/wallet';

const STAGES: Array<{key: MigrationStage; label: string}> = [
  {key: 'deposits', label: 'Deposit'},
  {key: 'recovering', label: 'Recover'},
  {key: 'convert', label: 'Convert'},
  {key: 'claims', label: 'Claim'},
];

function clock(s: number): string {
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** /migrate: the pooper scooper. Any Robinhood token with a market, into $SQUARE. */
export function MigrateIndex() {
  const wallet = useWallet();
  const {navigate} = useRouter();
  const [list, setList] = useState<Address[] | null>(null);
  const [q, setQ] = useState('');
  const [probe, setProbe] = useState<{token: Address; venue: Address; name: string; symbol: string; existing: Address[]} | null | 'loading'>(null);
  const [terms, setTerms] = useState({epochHours: 24, epochs: 3, decayPct: 10, mandate: 0, sellCapPct: 25, cooldownMin: 10, impactPct: 15, recoverDays: 7, vestDays: 3, claimDays: 90});
  const [busy, setBusy] = useState(false);
  // the wallet picker
  const [bags, setBags] = useState<WalletToken[] | null>(null);
  const [bagsErr, setBagsErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<Address>>(new Set());
  const [step, setStep] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet.address || !batchDeployed) {
      setBags(null);
      return;
    }
    let dead = false;
    setBags(null);
    setBagsErr(null);
    data
      .walletTokens(wallet.address)
      .then(r => !dead && setBags(r))
      .catch(e => !dead && setBagsErr(e instanceof Error ? e.message : 'Could not read the wallet'));
    return () => {
      dead = true;
    };
  }, [wallet.address]);

  const sellable = (bags ?? []).filter(b => b.ok);
  const pickAll = () => setPicked(new Set(sellable.map(b => b.address)));
  const pickNone = () => setPicked(new Set());
  const toggle = (a: Address) => {
    const n = new Set(picked);
    if (n.has(a)) n.delete(a);
    else n.add(a);
    setPicked(n);
  };
  const scoopPicked = async () => {
    if (wallet.status === 'wrong-chain') return wallet.switchChain();
    if (wallet.status !== 'connected' || !wallet.client || !wallet.address) return wallet.connect();
    const toks = sellable.filter(b => picked.has(b.address)).map(b => b.address);
    if (toks.length === 0) return;
    setBusy(true);
    try {
      await tx.batchScoop(wallet.client, wallet.address, toks, terms, setStep);
      toast(`Scooped ${toks.length} token${toks.length === 1 ? '' : 's'}`);
      setPicked(new Set());
      load();
      if (wallet.address) data.walletTokens(wallet.address).then(setBags).catch(() => undefined);
    } catch (e) {
      toast((e instanceof Error ? e.message : 'Transaction failed').split('\n')[0].slice(0, 120), 'err');
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const load = useCallback(() => {
    data.migrations().then(setList).catch(() => setList([]));
  }, []);
  useEffect(load, [load]);
  useLive(load, 10_000, scooperDeployed);

  useEffect(() => {
    const t = q.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(t) || !scooperDeployed) {
      setProbe(null);
      return;
    }
    let dead = false;
    setProbe('loading');
    data
      .scoopable(t as Address)
      .then(r => !dead && setProbe({token: t as Address, ...r}))
      .catch(() => !dead && setProbe(null));
    return () => {
      dead = true;
    };
  }, [q]);

  const scoop = async () => {
    if (wallet.status === 'wrong-chain') return wallet.switchChain();
    if (wallet.status !== 'connected' || !wallet.client || !wallet.address) return wallet.connect();
    if (!probe || probe === 'loading') return;
    setBusy(true);
    try {
      const r = await tx.scoop(wallet.client, wallet.address, probe.token, terms);
      toast(`Scooped $${probe.symbol}`);
      if (r.migrate) navigate(`/migrate/${r.migrate}`);
      else load();
    } catch (e) {
      toast((e instanceof Error ? e.message : 'Transaction failed').split('\n')[0].slice(0, 120), 'err');
    } finally {
      setBusy(false);
    }
  };
  const canScoop = probe && probe !== 'loading' && probe.venue !== '0x0000000000000000000000000000000000000000';
  const field = (k: keyof typeof terms, label: string, suffix: string) => (
    <Input key={k} label={label} mono inputMode="decimal" suffix={suffix} value={String(terms[k])} onChange={e => setTerms({...terms, [k]: Number(e.target.value)})} />
  );

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-100">Migrate</h1>
      <p className="measure mt-1.5 text-sm text-ink-400">
        Any token on {BRAND.chainName} with a market, into ${BRAND.token}. Holders deposit it in epochs, the first epoch one for one and each later one
        for less. Once the first epoch closes, anyone sells the deposits into wherever it trades, in capped slices, the ETH buys ${BRAND.token} on
        its curve, and depositors vest it. If recovery cannot finish, everyone takes their share back. No owner, no keys, anyone can start one.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <section className="rounded-lg border border-brass-700/40 bg-ink-900 p-4">
          <h2 className="font-medium text-ink-100">Scoop your bags</h2>
          {!scooperDeployed ? (
            <p className="mt-2 text-sm text-ink-500">The scooper is not on {BRAND.chainName} yet.</p>
          ) : (
            <>
              {wallet.status !== 'connected' ? (
                <div className="mt-3">
                  <p className="text-sm text-ink-400">Connect and every token you hold that has a market shows up here. Pick all, none or some.</p>
                  <Button className="mt-3 w-full" onClick={wallet.connect} loading={wallet.status === 'connecting'}>
                    {wallet.status === 'wrong-chain' ? `Switch to ${BRAND.chainName}` : 'Connect wallet'}
                  </Button>
                </div>
              ) : !batchDeployed ? null : bagsErr ? (
                <p className="mt-3 text-sm text-down-400">{bagsErr}</p>
              ) : bags === null ? (
                <Skeleton className="mt-3 h-32 w-full" />
              ) : bags.length === 0 ? (
                <p className="mt-3 text-sm text-ink-500">No tokens in this wallet on {BRAND.chainName}.</p>
              ) : (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-ink-500">
                      {sellable.length} of {bags.length} have a market · {picked.size} picked
                    </span>
                    <span className="flex gap-1">
                      <button onClick={pickAll} className="rounded px-2 py-0.5 text-brass-400 hover:bg-ink-800">
                        all
                      </button>
                      <button onClick={pickNone} className="rounded px-2 py-0.5 text-ink-400 hover:bg-ink-800">
                        none
                      </button>
                    </span>
                  </div>
                  <ul className="mt-2 max-h-72 divide-y divide-ink-800 overflow-y-auto rounded-md border border-ink-800">
                    {bags.map(b => (
                      <li key={b.address}>
                        <label className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm ${b.ok ? 'hover:bg-ink-850' : 'opacity-50'}`}>
                          <input type="checkbox" className="accent-brass-500" disabled={!b.ok} checked={picked.has(b.address)} onChange={() => toggle(b.address)} />
                          <span className="min-w-0 flex-1 truncate text-ink-100">
                            {b.name} <span className="num text-ink-500">${b.symbol}</span>
                          </span>
                          <span className="num text-right text-[12px] text-ink-400">
                            {num(b.amount, 2)}
                            {b.usd ? <span className="text-ink-600"> · ${b.usd.toFixed(2)}</span> : null}
                          </span>
                          <span className={`num w-16 text-right text-[11px] ${b.ok ? (b.needsNew ? 'text-brass-400' : 'text-up-400') : 'text-ink-600'}`}>
                            {b.ok ? (b.needsNew ? 'new' : 'open') : 'no market'}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <Button className="mt-3 w-full" loading={busy} disabled={picked.size === 0} onClick={scoopPicked}>
                    {step ?? `Scoop ${picked.size} token${picked.size === 1 ? '' : 's'}`}
                  </Button>
                  <p className="mt-1.5 text-[12px] text-ink-500">One approval per token, then one transaction for all of them. Full balances.</p>
                </div>
              )}
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-ink-400 hover:text-ink-200">Scoop by address</summary>
                <div className="mt-2">
                  <Input label="Token address" mono placeholder="0x…" value={q} onChange={e => setQ(e.target.value)} aria-label="Token address" />
                </div>
              </details>
              {probe === 'loading' ? (
                <Skeleton className="mt-3 h-10 w-full" />
              ) : probe ? (
                <div className="mt-3 rounded-md border border-ink-800 bg-ink-950 p-3 text-sm">
                  <p className="text-ink-100">
                    {probe.name} <span className="num text-ink-500">${probe.symbol}</span>
                  </p>
                  {canScoop ? (
                    <p className="num mt-1 text-[12px] text-up-400">market found · venue {short(probe.venue)}</p>
                  ) : (
                    <p className="mt-1 text-[12px] text-down-400">No market this scooper can sell into: no Pons curve, no v4, v3 or v2 pool against ETH.</p>
                  )}
                  {probe.existing.length > 0 && (
                    <p className="mt-1 text-[12px] text-ink-500">
                      already scooped {probe.existing.length}×:{' '}
                      <Link to={`/migrate/${probe.existing[probe.existing.length - 1]}`} className="text-brass-400 hover:underline">
                        latest
                      </Link>
                    </p>
                  )}
                </div>
              ) : null}
              <details className="mt-3 text-sm" open={false}>
                <summary className="cursor-pointer text-ink-400 hover:text-ink-200">Terms</summary>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {field('epochHours', 'Epoch length', 'h')}
                  {field('epochs', 'Epochs', '#')}
                  {field('decayPct', 'Decay per epoch', '%')}
                  {field('mandate', 'Mandate', 'tokens')}
                  {field('sellCapPct', 'Slice cap', '% left')}
                  {field('cooldownMin', 'Cooldown', 'min')}
                  {field('impactPct', 'Max impact', '%')}
                  {field('recoverDays', 'Recovery window', 'd')}
                  {field('vestDays', 'Vest', 'd')}
                  {field('claimDays', 'Claim window', 'd')}
                </div>
                <p className="mt-2 text-[12px] text-ink-500">Floors: epochs of 10 minutes, cooldown of 30 seconds, recovery window of an hour, claim window of a week.</p>
              </details>
              {q.trim() && (
                <Button className="mt-3 w-full" variant="secondary" loading={busy} disabled={wallet.status === 'connected' && !canScoop} onClick={scoop}>
                  {wallet.status === 'wrong-chain' ? `Switch to ${BRAND.chainName}` : wallet.status === 'connected' ? 'Scoop this address' : 'Connect wallet'}
                </Button>
              )}
            </>
          )}
        </section>

        <section>
          <h2 className="text-[13px] text-ink-400">Takeovers</h2>
          <div className="mt-2">
            {!scooperDeployed ? (
              <Empty title="Not on chain yet" body="The scooper factory has not been deployed. This page reads the chain and nothing else." />
            ) : list === null ? (
              <Skeleton className="h-24 w-full" />
            ) : list.length === 0 ? (
              <Empty title="No takeovers yet" body="The first one appears here the moment it is created." />
            ) : (
              <ul className="space-y-2">
                {list.map(a => (
                  <li key={a}>
                    <MigrateRow address={a} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function MigrateRow({address}: {address: Address}) {
  const [m, setM] = useState<Migration | null>(null);
  useEffect(() => {
    data.migration(address).then(setM).catch(() => setM(null));
  }, [address]);
  return (
    <Link to={`/migrate/${address}`} className="flex items-center justify-between gap-3 rounded-lg border border-ink-800 bg-ink-900 px-4 py-3 hover:border-ink-700">
      {m ? (
        <>
          <div className="min-w-0">
            <p className="truncate font-medium text-ink-100">
              {m.oldName} <span className="num text-sm font-normal text-ink-500">${m.oldSymbol}</span>
              <span className="text-ink-500"> → </span>${BRAND.token}
            </p>
            <p className="num text-[12px] text-ink-500">
              {num(m.totalDeposited, 0)} deposited · {m.depositors} depositors · {m.recovered ? eth(m.recovered) + ' recovered' : ''}
            </p>
          </div>
          <Badge tone={m.stage === 'claims' ? 'up' : m.stage === 'failed' ? 'down' : 'brass'}>{m.stage}</Badge>
        </>
      ) : (
        <Skeleton className="h-8 w-full" />
      )}
    </Link>
  );
}

/** /migrate/:address: one takeover, live. */
export function Migrate({address}: {address: string}) {
  const wallet = useWallet();
  const [m, setM] = useState<Migration | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [amt, setAmt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async () => {
    try {
      setM(await data.migration(address as Address, wallet.address));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read the migration');
    }
  }, [address, wallet.address]);
  useEffect(() => {
    void load();
  }, [load]);
  useLive(load, 3000, true);
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const run = async (what: string, fn: () => Promise<unknown>, ok: string) => {
    if (wallet.status === 'wrong-chain') return wallet.switchChain();
    if (wallet.status !== 'connected' || !wallet.client || !wallet.address) return wallet.connect();
    setBusy(what);
    try {
      await fn();
      toast(ok);
      await load();
    } catch (e) {
      toast((e instanceof Error ? e.message : 'Transaction failed').split('\n')[0].slice(0, 120), 'err');
    } finally {
      setBusy(null);
    }
  };
  const w = wallet.client!;
  const me = wallet.address!;
  const explorer = robinhood.blockExplorers.default.url;

  if (err && !m) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <ErrorBox title="Could not read the migration" body={err} retry={() => void load()} />
      </main>
    );
  }
  if (!m) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-6 h-64 w-full" />
      </main>
    );
  }

  const addr = address as Address;
  const epochEnd = m.start + Math.min(m.epochNow + 1, m.epochs) * m.epochLength;
  const firstClose = m.start + m.epochLength;
  const stageIdx = Math.max(0, STAGES.findIndex(s => s.key === m.stage));
  const nextSell = m.lastSell + m.cooldown;
  const vestPct = m.converted ? Math.min(100, m.vestLength ? ((now - m.claimStart) / m.vestLength) * 100 : 100) : 0;
  const claimEnd = m.claimStart + m.claimWindow;
  const label = wallet.status === 'wrong-chain' ? `Switch to ${BRAND.chainName}` : wallet.status === 'connected' ? null : 'Connect wallet';

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link to="/migrate" className="text-[13px] text-ink-500 hover:text-ink-200">
          ← Migrate
        </Link>
        <h1 className="text-lg font-semibold text-ink-100">
          {m.oldName} <span className="num text-sm font-normal text-ink-500">${m.oldSymbol}</span>
          <span className="text-ink-500"> → </span>${BRAND.token}
        </h1>
        <Badge tone={m.stage === 'claims' ? 'up' : m.stage === 'failed' ? 'down' : 'brass'}>{m.stage}</Badge>
        <span className="num text-[11px] text-ink-500">
          <a href={`${explorer}/address/${addr}`} target="_blank" rel="noreferrer" className="hover:text-ink-200">
            {short(addr)} ↗
          </a>
        </span>
      </div>

      <ol className="mt-5 grid grid-cols-4 gap-1" aria-label="Stages">
        {STAGES.map((s, i) => (
          <li key={s.key} className="text-[12px]">
            <div className={`h-1 rounded ${i < stageIdx ? 'bg-brass-700' : i === stageIdx ? 'bg-brass-500' : 'bg-ink-800'}`} />
            <p className={`mt-1 ${i === stageIdx ? 'text-ink-100' : 'text-ink-500'}`}>{s.label}</p>
          </li>
        ))}
      </ol>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <section className="space-y-4">
          {m.stage === 'deposits' || m.stage === 'waiting' ? (
            <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-medium text-ink-100">
                  Epoch {Math.min(m.epochNow + 1, m.epochs)} of {m.epochs} · credits {pct(m.rateNowBps / 100)}
                </h2>
                <span className="num text-[12px] text-ink-500">
                  {m.epochNow < m.epochs ? `next epoch in ${clock(epochEnd - now)}` : 'deposits closed'}
                </span>
              </div>
              <p className="measure mt-1 text-sm text-ink-400">
                Deposit ${m.oldSymbol} now and your credit is fixed at {pct(m.rateNowBps / 100)} of one for one. Every later epoch credits{' '}
                {m.decayBps / 100}% less. Selling into the old curve starts {firstClose > now ? `in ${clock(firstClose - now)}` : 'now'}
                {m.mandate > 0 ? ` once ${num(m.mandate, 0)} ${m.oldSymbol} are in.` : '.'}
              </p>
              {m.mandate > 0 && (
                <div className="mt-3">
                  <div className="flex justify-between text-[12px]">
                    <span className="text-ink-500">Mandate</span>
                    <span className="num text-ink-300">
                      {num(m.totalDeposited, 0)} / {num(m.mandate, 0)}
                    </span>
                  </div>
                  <div className="mt-1">
                    <Progress value={Math.min(100, (m.totalDeposited / m.mandate) * 100)} label="Mandate" />
                  </div>
                </div>
              )}
              {m.depositsOpen && (
                <div className="mt-4">
                  <Input
                    label={`Deposit ${m.oldSymbol}`}
                    mono
                    inputMode="decimal"
                    placeholder="0"
                    value={amt}
                    onChange={e => setAmt(e.target.value)}
                    suffix={m.oldSymbol}
                    hint={m.you ? `wallet ${num(m.you.oldBalance, 2)} ${m.oldSymbol}` : undefined}
                  />
                  <div className="mt-2 flex gap-2">
                    {m.you && m.you.oldBalance > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => setAmt(String(m.you!.oldBalance))}>
                        max
                      </Button>
                    )}
                    <Button
                      className="flex-1"
                      loading={busy === 'deposit'}
                      disabled={wallet.status === 'connected' && !(Number(amt) > 0)}
                      onClick={() =>
                        run('deposit', () => tx.migrateDeposit(w, me, addr, m.oldToken, Number(amt)), `Deposited ${amt} ${m.oldSymbol}`).then(() => setAmt(''))
                      }>
                      {label ?? `Deposit at ${pct(m.rateNowBps / 100)}`}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {m.stage === 'recovering' && (
            <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
              <h2 className="font-medium text-ink-100">Selling into the old curve</h2>
              <p className="measure mt-1 text-sm text-ink-400">
                Anyone can sell the next slice: at most {m.sellCapBps / 100}% of what is left per trade, {clock(m.cooldown)} between trades, and
                each trade must clear its spot price less the impact allowance. Deadline {clock(m.recoverDeadline - now)}.
              </p>
              <dl className="num mt-3 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-3">
                <div>
                  <dt className="text-ink-500">left to sell</dt>
                  <dd className="text-ink-100">{num(m.remaining, 0)}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">recovered</dt>
                  <dd className="text-ink-100">{eth(m.recovered)}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">next slice</dt>
                  <dd className="text-ink-100">{nextSell > now ? clock(nextSell - now) : 'ready'}</dd>
                </div>
              </dl>
              <div className="mt-3">
                <Progress value={m.totalDeposited ? (1 - m.remaining / m.totalDeposited) * 100 : 0} label="Recovery" />
              </div>
              <Button className="mt-4 w-full" loading={busy === 'recover'} disabled={wallet.status === 'connected' && !m.canRecover} onClick={() => run('recover', () => tx.migrateCall(w, me, addr, 'recover'), 'Slice sold')}>
                {label ?? (m.canRecover ? 'Sell the next slice' : `Cooling down · ${clock(nextSell - now)}`)}
              </Button>
            </div>
          )}

          {m.stage === 'convert' && (
            <div className="rounded-lg border border-brass-700/40 bg-ink-900 p-4">
              <h2 className="font-medium text-ink-100">Recovery complete</h2>
              <p className="measure mt-1 text-sm text-ink-400">
                {eth(m.recovered)} sits in the contract. Converting buys ${BRAND.token} on its curve with all of it and starts the vest. Anyone can
                press this.
              </p>
              <Button className="mt-4 w-full" loading={busy === 'convert'} onClick={() => run('convert', () => tx.migrateConvert(w, me, addr), `Converted into $${BRAND.token}`)}>
                {label ?? `Convert ${eth(m.recovered)} into $${BRAND.token}`}
              </Button>
            </div>
          )}

          {m.stage === 'claims' && (
            <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
              <h2 className="font-medium text-ink-100">
                {num(m.totalSquare, 0)} ${BRAND.token} vesting
              </h2>
              <p className="measure mt-1 text-sm text-ink-400">
                Bought with {eth(m.recovered)}. Vests linearly over {clock(m.vestLength)}, pro rata to credits. Claims stay open for{' '}
                {clock(m.claimWindow)}; after that what is left goes to the sink and reaches ${BRAND.token} stakers.
              </p>
              <div className="mt-3 flex justify-between text-[12px]">
                <span className="text-ink-500">Vested</span>
                <span className="num text-ink-300">{pct(vestPct, 1)}</span>
              </div>
              <div className="mt-1">
                <Progress value={vestPct} tone="up" label="Vested" />
              </div>
              {m.you && (
                <dl className="num mt-3 grid grid-cols-3 gap-3 text-[13px]">
                  <div>
                    <dt className="text-ink-500">your share</dt>
                    <dd className="text-ink-100">{m.totalCredits ? pct((m.you.credits / m.totalCredits) * 100, 2) : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-500">claimed</dt>
                    <dd className="text-ink-100">{num(m.you.claimed, 2)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-500">claimable</dt>
                    <dd className="text-up-400">{num(m.you.claimable, 2)}</dd>
                  </div>
                </dl>
              )}
              <Button
                className="mt-4 w-full"
                loading={busy === 'claim'}
                disabled={wallet.status === 'connected' && !(m.you && m.you.claimable > 0)}
                onClick={() => run('claim', () => tx.migrateCall(w, me, addr, 'claim'), `Claimed $${BRAND.token}`)}>
                {label ?? `Claim ${m.you ? num(m.you.claimable, 2) : ''} $${BRAND.token}`}
              </Button>
              {now > claimEnd && (
                <Button className="mt-2 w-full" variant="secondary" loading={busy === 'sweep'} onClick={() => run('sweep', () => tx.migrateCall(w, me, addr, 'sweep'), 'Swept to the sink')}>
                  Sweep what is left to the sink
                </Button>
              )}
            </div>
          )}

          {m.stage === 'failed' && (
            <div className="rounded-lg border border-down-500/30 bg-ink-900 p-4">
              <h2 className="font-medium text-ink-100">Recovery did not finish</h2>
              <p className="measure mt-1 text-sm text-ink-400">
                {m.totalDeposited < m.mandate ? 'The mandate was not met before deposits closed.' : 'The deadline passed with tokens unsold.'} Every depositor
                takes back their share of the {num(m.remaining, 0)} {m.oldSymbol} still held and the {eth(m.recovered)} recovered.
              </p>
              <Button
                className="mt-4 w-full"
                variant="secondary"
                loading={busy === 'rescue'}
                disabled={wallet.status === 'connected' && !(m.you && m.you.deposited > 0 && !m.you.rescued)}
                onClick={() => run('rescue', () => tx.migrateCall(w, me, addr, 'rescue'), 'Rescued')}>
                {label ?? (m.you?.rescued ? 'Rescued' : 'Take back my share')}
              </Button>
            </div>
          )}

          {m.you && m.you.deposited > 0 && (
            <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
              <h2 className="text-[13px] text-ink-400">Your position</h2>
              <dl className="num mt-2 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-3">
                <div>
                  <dt className="text-ink-500">deposited</dt>
                  <dd className="text-ink-100">
                    {num(m.you.deposited, 2)} {m.oldSymbol}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-500">credits</dt>
                  <dd className="text-ink-100">{num(m.you.credits, 2)}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">share</dt>
                  <dd className="text-brass-300">{m.totalCredits ? pct((m.you.credits / m.totalCredits) * 100, 2) : '—'}</dd>
                </div>
              </dl>
            </div>
          )}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-[72px] lg:self-start">
          <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
            <dl className="num space-y-2 text-[13px]">
              {[
                ['Deposited', `${num(m.totalDeposited, 0)} ${m.oldSymbol}`],
                ['Depositors', String(m.depositors)],
                ['Credits', num(m.totalCredits, 0)],
                ['Recovered', eth(m.recovered)],
                ['Epochs', `${m.epochs} × ${clock(m.epochLength)}`],
                ['Decay per epoch', `${m.decayBps / 100}%`],
                ['Mandate', m.mandate ? `${num(m.mandate, 0)} ${m.oldSymbol}` : 'none'],
                ['Slice cap', `${m.sellCapBps / 100}% of what is left`],
                ['Cooldown', clock(m.cooldown)],
                ['Vest', clock(m.vestLength)],
                ['Claim window', clock(m.claimWindow)],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-ink-500">{k}</dt>
                  <dd className="text-right text-ink-100">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="num space-y-1 text-[12px] text-ink-500">
            <p>
              old token{' '}
              <a href={`${explorer}/address/${m.oldToken}`} target="_blank" rel="noreferrer" className="text-brass-400 hover:underline">
                {short(m.oldToken)}
              </a>
            </p>
            <p>
              sells into{' '}
              <a href={`${explorer}/address/${m.venue}`} target="_blank" rel="noreferrer" className="text-brass-400 hover:underline">
                {short(m.venue)}
              </a>
            </p>
            <p>
              buys{' '}
              <Link to={`/t/${ADDR.square}`} className="text-brass-400 hover:underline">
                ${BRAND.token} {short(ADDR.square)}
              </Link>
            </p>
          </div>
          <p className="measure text-[12px] text-ink-500">
            Each claim is a ${BRAND.token} transfer, so the k-th claim in a block pays the square. Claim in a quiet block and it is free.
          </p>
        </aside>
      </div>
    </main>
  );
}
