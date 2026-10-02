import {useCallback, useEffect, useState} from 'react';
import type {Address} from 'viem';
import {Button} from '../components/ui/Button';
import {Input} from '../components/ui/Field';
import {Empty, ErrorBox, Skeleton, toast} from '../components/ui/Bits';
import {BRAND} from '../lib/brand';
import {ADDR, robinhood} from '../lib/chain';
import {data, tx} from '../lib/data';
import {num, short} from '../lib/format';
import {Link} from '../lib/router';
import type {SinkState} from '../lib/types';
import {useWallet} from '../lib/wallet';

export function Square() {
  const wallet = useWallet();
  const [s, setS] = useState<SinkState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [amt, setAmt] = useState('');
  const [mode, setMode] = useState<'stake' | 'unstake'>('stake');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    data
      .sink(wallet.address)
      .then(setS)
      .catch(e => setErr(e instanceof Error ? e.message : 'Could not read the sink'));
  }, [wallet.address]);
  useEffect(load, [load]);

  const run = async (what: string, fn: () => Promise<unknown>, ok: string) => {
    if (wallet.status === 'wrong-chain') return wallet.switchChain();
    if (wallet.status !== 'connected' || !wallet.client || !wallet.address) return wallet.connect();
    setBusy(what);
    try {
      await fn();
      toast(ok);
      load();
    } catch (e) {
      toast((e instanceof Error ? e.message : 'Transaction failed').split('\n')[0].slice(0, 120), 'err');
    } finally {
      setBusy(null);
    }
  };
  const w = wallet.client!;
  const me = wallet.address!;
  const n = Number(amt);

  if (!data.deployed) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <Empty title={`$${BRAND.token} is not on ${BRAND.chainName} yet`} body="The sink and the token deploy with the factory." />
      </main>
    );
  }

  const share = s && s.totalStaked ? (s.yourStake / s.totalStaked) * 100 : 0;
  const explorer = robinhood.blockExplorers.default.url;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-100">${BRAND.token}</h1>
      <p className="measure mt-1.5 text-sm text-ink-400">
        Every reference fee on a token launched on {BRAND.name} ends up here. New launches pay a settler that sells the fee for ETH, sends half to a sink with no owner and half here wrapped, and burns nothing; the flagship's fees arrive in kind. {s ? `${100 - s.wizardsBps / 100}%` : 'Most'} goes to
        stakers pro rata to their stake as of the previous block; the rest to the Stacc Wizards fanout. Nobody can pause, redirect or
        withdraw it.{' '}
        <a href={`${explorer}/address/${ADDR.sink}`} target="_blank" rel="noreferrer" className="text-brass-400 hover:underline">
          pool {short(ADDR.sink)}
        </a>{' '}
        ·{' '}
        <Link to={`/t/${ADDR.square}`} className="text-brass-400 hover:underline">
          stake token ${BRAND.token} {short(ADDR.square)}
        </Link>
        {ADDR.legacySink && (
          <>
            {' '}
            ·{' '}
            <a href={`${explorer}/address/${ADDR.legacySink}`} target="_blank" rel="noreferrer" className="text-brass-400 hover:underline">
              fee sink {short(ADDR.legacySink)}
            </a>
          </>
        )}
      </p>

      {err ? (
        <div className="mt-8">
          <ErrorBox title="Could not read the sink" body={err} retry={load} />
        </div>
      ) : (
        <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_360px]">
          <section aria-labelledby="dist-h">
            <h2 id="dist-h" className="text-[13px] font-medium uppercase tracking-wide text-ink-500">
              Fees in the sink
            </h2>
            {!s ? (
              <div className="mt-3 space-y-2">
                {Array.from({length: 3}, (_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : s.tokens.length === 0 ? (
              <div className="mt-3">
                <Empty title="Nothing here yet" body="The first machine that walks a launch fills this. Anyone can sync a token's fees once they land." />
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-ink-850 overflow-hidden rounded-lg border border-ink-800">
                {s.tokens.map(t => (
                  <li key={t.token} className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-ink-900 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <Link to={`/t/${t.token}`} className="font-medium text-ink-100 hover:text-brass-300">
                        ${t.symbol}
                      </Link>
                      <p className="num text-[12px] text-ink-500">
                        {t.distributions.length} distribution{t.distributions.length === 1 ? '' : 's'}
                        {t.pending > 0 ? ` · ${num(t.pending, 4)} unsynced` : ''}
                        {t.wizardsUnharvested > 0 ? ` · ${num(t.wizardsUnharvested, 2)} at the wizards, unharvested` : ''}
                        {t.settlerPending > 0 ? ` · ${num(t.settlerPending, 2)} at the settler, unsold` : ''}
                      </p>
                    </div>
                    <div className="num text-right text-[13px]">
                      <p className="text-ink-200">{num(t.distributions.reduce((a, d) => a + d.amount, 0), 2)} to stakers</p>
                      <p className="text-ink-500">yours {wallet.status === 'connected' ? num(t.claimable, 4) : '—'}</p>
                    </div>
                    {t.settlerPending > 0 && (
                      <Button size="sm" variant="ghost" loading={busy === `settle-${t.token}`} onClick={() => run(`settle-${t.token}`, () => tx.settle(w, me, t.token as Address), `Settled ${t.symbol} into ETH`)}>
                        Settle to ETH
                      </Button>
                    )}
                    {t.wizardsUnharvested > 0 && (
                      <Button size="sm" variant="ghost" loading={busy === `harvest-${t.token}`} onClick={() => run(`harvest-${t.token}`, () => tx.harvestWizards(w, me, t.token as Address), `Harvested ${t.symbol} for the wizards`)}>
                        Harvest wizards
                      </Button>
                    )}
                    {t.pending > 0 && (
                      <Button size="sm" variant="ghost" loading={busy === `sync-${t.token}`} onClick={() => run(`sync-${t.token}`, () => tx.sync(w, me, t.token as Address), `Synced ${t.symbol}`)}>
                        Sync
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={wallet.status === 'connected' && t.claimable === 0}
                      loading={busy === `claim-${t.token}`}
                      onClick={() => run(`claim-${t.token}`, () => tx.claim(w, me, t.token as Address), `Claimed ${t.symbol}`)}>
                      {wallet.status === 'connected' ? 'Claim' : 'Connect'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <aside className="space-y-4 lg:sticky lg:top-[72px] lg:self-start">
            <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
              <dl className="num space-y-2 text-[13px]">
                <div className="flex justify-between">
                  <dt className="text-ink-500">Total staked</dt>
                  <dd className="text-ink-100">{s ? num(s.totalStaked, 2) : <Skeleton className="inline-block h-3 w-20" />}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">Your stake</dt>
                  <dd className="text-ink-100">{s && wallet.status === 'connected' ? `${num(s.yourStake, 2)} (${share.toFixed(2)}%)` : '—'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-500">Wallet</dt>
                  <dd className="text-ink-100">{s && wallet.status === 'connected' ? num(s.yourWallet, 2) : '—'}</dd>
                </div>
              </dl>
              <div className="mt-4 flex gap-1 text-[13px]">
                {(['stake', 'unstake'] as const).map(m => (
                  <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m} className={`rounded px-2 py-1 active:translate-y-px ${mode === m ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}>
                    {m}
                  </button>
                ))}
              </div>
              <div className="mt-2">
                <Input
                  label={`${mode === 'stake' ? 'Stake' : 'Unstake'} ${BRAND.token}`}
                  mono
                  inputMode="decimal"
                  placeholder="0"
                  value={amt}
                  onChange={e => setAmt(e.target.value)}
                  suffix={BRAND.token}
                  hint="Staking is itself a transfer: if it is not the first reference to SQUARE in its block, it pays the square."
                />
              </div>
              <div className="mt-2 flex gap-1.5">
                {([0.25, 0.5, 1] as const).map(p => (
                  <button
                    key={p}
                    disabled={!s || wallet.status !== 'connected'}
                    onClick={() => {
                      if (!s) return;
                      const base = mode === 'stake' ? s.yourWallet : s.yourStake;
                      setAmt(base > 0 ? String(Number((base * p).toFixed(6))) : '');
                    }}
                    className="num rounded border border-brass-700/40 px-2 py-1 text-[12px] text-brass-300 transition-colors hover:border-brass-500 hover:text-brass-200 active:translate-y-px active:bg-brass-900 disabled:opacity-40 disabled:active:translate-y-0 focus-visible:outline-brass-400">
                    {p === 1 ? 'max' : `${p * 100}%`}
                  </button>
                ))}
              </div>
              <Button
                className="mt-3 w-full"
                loading={busy === 'stake'}
                disabled={wallet.status === 'connected' && !(n > 0)}
                onClick={() =>
                  run(
                    'stake',
                    () => (mode === 'stake' ? tx.stake(w, me, n) : tx.unstake(w, me, n)),
                    `${mode === 'stake' ? 'Staked' : 'Unstaked'} ${amt} ${BRAND.token}`,
                  ).then(() => setAmt(''))
                }>
                {wallet.status === 'wrong-chain' ? `Switch to ${BRAND.chainName}` : wallet.status === 'connected' ? (mode === 'stake' ? 'Stake' : 'Unstake') : 'Connect wallet'}
              </Button>
            </div>
            <p className="measure text-[12px] text-ink-500">
              Distributions are settled against stake checkpoints, so a claim can be made any time and in chunks of 50. Staking in the
              same block as a distribution does not count for it.
            </p>
          </aside>
        </div>
      )}
    </main>
  );
}
