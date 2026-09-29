import {useEffect, useMemo, useState} from 'react';
import {data, tx} from '../lib/data';
import {referenceFeeBps} from '../lib/fee';
import {erc20Abi, publicClient} from '../lib/chain';
import {num, pct} from '../lib/format';
import type {Launch} from '../lib/types';
import {useWallet} from '../lib/wallet';
import {Button} from './ui/Button';
import {Input} from './ui/Field';
import {Tabs, toast} from './ui/Bits';
import {ReferenceMeter} from './ReferenceMeter';

type Side = 'buy' | 'sell';
type Quote = Awaited<ReturnType<typeof data.quote>>;

export function TradePanel({l, onTraded}: {l: Launch; onTraded?: () => void}) {
  const wallet = useWallet();
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // wallet balances for the quick buttons: ETH for buys (max leaves 1% for gas), the token for sells
  const [bal, setBal] = useState<{eth: number; token: number} | null>(null);
  useEffect(() => {
    if (!wallet.address) {
      setBal(null);
      return;
    }
    let dead = false;
    Promise.all([
      publicClient.getBalance({address: wallet.address}),
      publicClient.readContract({address: l.token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address]}),
    ])
      .then(([e, t]) => !dead && setBal({eth: Number(e) / 1e18, token: Number(t) / 1e18}))
      .catch(() => !dead && setBal(null));
    return () => {
      dead = true;
    };
  }, [wallet.address, l.token, busy]);
  const quick = (pct: number) => {
    if (!bal) return;
    const base = side === 'buy' ? bal.eth : bal.token;
    const v = pct >= 1 ? (side === 'buy' ? base * 0.99 : base) : base * pct;
    setAmount(v > 0 ? String(Number(v.toFixed(side === 'buy' ? 6 : 4))) : '');
  };

  const n = Number(amount);
  const invalid = amount !== '' && (!Number.isFinite(n) || n <= 0);
  const viaPools = l.kind === 'pools';
  const graduated = l.phase !== 'curve' && !viaPools;
  const recipient = wallet.address ?? '0x0000000000000000000000000000000000000001';

  useEffect(() => {
    if (!n || invalid || graduated) {
      setQuote(null);
      return;
    }
    let live = true;
    setQuoting(true);
    const t = setTimeout(() => {
      data
        .quote(l.curve, side, n, recipient)
        .then(q => live && setQuote(q))
        .catch(() => live && setQuote(null))
        .finally(() => live && setQuoting(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [n, invalid, side, l.curve, recipient, graduated]);

  const minOut = useMemo(() => (quote ? quote.out * (1 - slippage / 100) : 0), [quote, slippage]);

  const submit = async () => {
    setError(null);
    if (wallet.status === 'wrong-chain') return wallet.switchChain();
    if (wallet.status !== 'connected' || !wallet.client || !wallet.address) return wallet.connect();
    if (!quote) return;
    setBusy(true);
    try {
      const hash =
        side === 'buy'
          ? await tx.buy(wallet.client, l.curve, n, minOut, wallet.address)
          : await tx.sell(wallet.client, l.token, l.curve, n, minOut, wallet.address);
      toast(`${side === 'buy' ? 'Bought' : 'Sold'} ${l.symbol} · ${hash.slice(0, 10)}…`);
      setAmount('');
      onTraded?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Transaction failed';
      setError(msg.split('\n')[0].slice(0, 160));
      toast('Transaction failed', 'err');
    } finally {
      setBusy(false);
    }
  };

  const label =
    wallet.status === 'wrong-chain'
      ? 'Switch to Robinhood Chain'
      : wallet.status !== 'connected'
        ? 'Connect wallet'
        : !amount
          ? 'Enter an amount'
          : quoting
            ? 'Quoting…'
            : `${side === 'buy' ? 'Buy' : 'Sell'} ${l.symbol}`;

  if (graduated) {
    return (
      <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
        <p className="text-sm font-medium text-ink-100">{l.phase === 'pool' ? 'Trading on the pool' : 'Graduating'}</p>
        <p className="mt-1 text-[13px] text-ink-400">
          {l.phase === 'pool'
            ? 'The curve closed. This token trades on its permanent Uniswap v4 position now, through any router that speaks v4. Every transfer there is a reference.'
            : 'The curve has been swept and the pool is being created. Trading resumes on the pool.'}
        </p>
        <div className="mt-4">
          <ReferenceMeter refs={l.referencesThisBlock} freeRefs={l.twoRatchets ? 2 : 1} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
      <div className="flex items-center justify-between">
        <Tabs
          value={side}
          onChange={s => {
            setSide(s);
            setAmount('');
          }}
          options={[
            {value: 'buy', label: 'Buy'},
            {value: 'sell', label: 'Sell'},
          ]}
        />
        <div className="flex items-center gap-1 text-[12px] text-ink-500">
          <span>slip</span>
          {[0.5, 1, 3].map(s => (
            <button
              key={s}
              onClick={() => setSlippage(s)}
              aria-pressed={slippage === s}
              className={`num rounded px-1.5 py-0.5 transition-colors ${slippage === s ? 'bg-ink-700 text-ink-100' : 'hover:text-ink-300'}`}>
              {s}%
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <Input
          label={side === 'buy' ? 'You pay' : 'You sell'}
          mono
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          suffix={side === 'buy' ? 'ETH' : l.symbol}
          error={invalid ? 'Enter a positive amount' : error ?? undefined}
          disabled={busy}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {side === 'buy' &&
            ['0.01', '0.05', '0.1', '0.5'].map(q => (
              <button
                key={q}
                onClick={() => setAmount(q)}
                className="num rounded border border-ink-800 px-2 py-1 text-[12px] text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200 focus-visible:outline-brass-400">
                {q}
              </button>
            ))}
          {bal &&
            ([0.25, 0.5, 1] as const).map(p => (
              <button
                key={p}
                onClick={() => quick(p)}
                title={p === 1 ? (side === 'buy' ? '99% of your ETH, the rest is gas' : 'Everything') : `${p * 100}% of what you hold`}
                className="num rounded border border-brass-700/40 px-2 py-1 text-[12px] text-brass-300 transition-colors hover:border-brass-500 hover:text-brass-200 focus-visible:outline-brass-400">
                {p === 1 ? 'max' : `${p * 100}%`}
              </button>
            ))}
        </div>
      </div>

      <dl className="num mt-4 space-y-1.5 text-[13px]">
        <Row k="You receive" v={quote ? `${num(quote.out, 4)} ${side === 'buy' ? l.symbol : 'ETH'}` : '—'} strong />
        <Row k={`Min after ${slippage}% slip`} v={quote ? `${num(minOut, 4)}` : '—'} />
        <Row k={viaPools ? 'Pool fee' : 'Curve fee'} v={quote ? `${quote.feeBps} bp${quote.taxBps ? ` + ${quote.taxBps} bp creator` : ''}` : '—'} />
        {quote && quote.snipeBps > 0 && <Row k="Snipe tax now" v={`${quote.snipeBps} bp`} tone="warn" />}
        <Row k="Price impact" v={quote ? pct(quote.impact, 2) : '—'} tone={quote && quote.impact > 5 ? 'warn' : undefined} />
      </dl>

      <Button
        className="mt-4 w-full"
        size="lg"
        variant={wallet.status !== 'connected' ? 'primary' : side === 'buy' ? 'up' : 'down'}
        disabled={wallet.status === 'connected' && (!quote || invalid || quoting)}
        loading={busy || wallet.status === 'connecting'}
        onClick={submit}>
        {label}
      </Button>

      {viaPools ? (
        <>
          <p className="mt-3 text-[12px] text-ink-500">
            This trades against the token's Uniswap v4 pool through the universal router: one transfer, so one reference. The first two transfers
            of this token in a block are free, and so are your first {l.slowFree ?? 16} trades in a week.
          </p>
          <p className="mt-1 text-[11px] text-ink-600">
            After that a buy arrives short by the fee, and a sell fails, because the pool is owed more than reaches it. Selling asks for two
            approvals the first time.
          </p>
        </>
      ) : (
        <>
          <p className="mt-3 text-[12px] text-ink-500">
            On the curve your trade is not a reference: buys and sells with the curve are never taxed by the square. The k-th reference
            rule starts when the token graduates to its pool.
          </p>
          <p className="mt-1 text-[11px] text-ink-600">Next reference on this token pays {referenceFeeBps(l.referencesThisBlock + 1, l.twoRatchets ? 2 : 1)} bp there.{l.twoRatchets ? ' Two ratchets: the first two references in a block are free, and a wallet\'s repeat touches within ~8 minutes pay on their own count.' : ''}</p>
          <p className="mt-2 text-[11px] text-ink-600">
            Scanner says 10% tax? It bought and sold in one transaction through a side pool and touched the token ten times. That is the square doing its job. One swap per block is free.
          </p>
        </>
      )}
    </div>
  );
}

function Row({k, v, strong, tone}: {k: string; v: string; strong?: boolean; tone?: 'warn'}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-500">{k}</dt>
      <dd className={`${strong ? 'font-medium text-ink-100' : tone === 'warn' ? 'text-warn-500' : 'text-ink-300'}`}>{v}</dd>
    </div>
  );
}
