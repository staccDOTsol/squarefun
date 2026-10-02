import {useCallback, useEffect, useState} from 'react';
import type {Address} from 'viem';
import {contagianTrade, payOptions} from '../lib/contagianTrade';
import type {Asset} from '../lib/contagian';
import {useWallet} from '../lib/wallet';
import {Tabs, toast} from './ui/Bits';
import {Button} from './ui/Button';
import {Input} from './ui/Field';
import {Flash} from './ui/Live';

const show = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}k` : n >= 1 ? n.toFixed(2) : n === 0 ? '0' : n.toPrecision(3));

/** Buy and sell a Contagian token straight through its pool: one swap, one transfer of the token. */
export function ContagianTrade({
  token,
  symbol,
  quote,
  underParity,
  tax,
  onDone,
}: {
  token: Address;
  symbol: string;
  quote: Asset;
  underParity: boolean;
  /** the vault's lagging rates now, in basis points (`taxBps()`), as the page last read them */
  tax?: {buyBps: number | null; sellBps: number | null};
  onDone: () => void;
}) {
  const wallet = useWallet();
  const pays = payOptions(quote);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [pay, setPay] = useState<Asset>(pays[0]);
  const [amount, setAmount] = useState('');
  const [out, setOut] = useState<number | null>(null);
  const [bal, setBal] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const me = wallet.address;
  const readBalances = useCallback(async () => {
    if (!me) return setBal({});
    setBal(await contagianTrade.balances(token, quote, me).catch(() => ({})));
  }, [token, quote, me]);
  useEffect(() => {
    void readBalances();
  }, [readBalances]);

  // what the pools would pay, a moment after the typing stops
  useEffect(() => {
    setOut(null);
    const n = Number(amount);
    if (!amount || !Number.isFinite(n) || n <= 0) return;
    let live = true;
    const t = setTimeout(async () => {
      const got = await contagianTrade.estimate(token, quote, side, pay, amount, me ?? token).catch(() => null);
      if (live) setOut(got);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [amount, side, pay, token, quote, me]);

  const spending = side === 'buy' ? pay : {address: token, symbol, decimals: 18};
  const have = bal[spending.address.toLowerCase()];
  const n = Number(amount);
  const tooMuch = have !== undefined && Number.isFinite(n) && n > have;

  const go = async () => {
    if (wallet.status === 'wrong-chain') return wallet.switchChain();
    if (wallet.status !== 'connected' || !wallet.client || !me) return wallet.connect();
    setBusy(true);
    try {
      if (side === 'buy') await contagianTrade.buy(wallet.client, me, token, quote, pay, amount);
      else await contagianTrade.sell(wallet.client, me, token, quote, amount);
      toast(side === 'buy' ? `Bought ${symbol}` : `Sold ${symbol}`);
      setAmount('');
      await readBalances();
      onDone();
    } catch (e) {
      toast((e instanceof Error ? e.message : 'Transaction failed').split('\n')[0].slice(0, 160), 'err');
    } finally {
      setBusy(false);
    }
  };

  const sellMost = async () => {
    if (wallet.status !== 'connected' || !wallet.client || !me) return wallet.connect();
    setBusy(true);
    try {
      const sold = await contagianTrade.sellMost(wallet.client, me, token, quote);
      toast(`Sold ${show(sold)} ${symbol}`);
      setAmount('');
      await readBalances();
      onDone();
    } catch (e) {
      toast((e instanceof Error ? e.message : 'Transaction failed').split('\n')[0].slice(0, 160), 'err');
    } finally {
      setBusy(false);
    }
  };

  const part = (share: number) => have !== undefined && setAmount(String(Math.floor(have * share * 1e6) / 1e6));
  const rule = underParity ? 'Under parity: buys are free, sells are taxed on top.' : 'Over parity: buys are taxed in tokens, sells are free.';
  // What this trade pays at the lagging rate. A trade also pays for its own push, and a machine pays more, so this is the least it can be.
  const bps = (side === 'buy' ? tax?.buyBps : tax?.sellBps) ?? null;
  const valid = Number.isFinite(n) && n > 0;
  const cost = bps === null || !valid ? null : side === 'buy' ? (out === null ? null : (out * bps) / 10_000) : (n * bps) / 10_000;
  const kept = side === 'buy' && out !== null && cost !== null ? out - cost : null;
  // a sale's tax is taken on top, from what is left: the sale and its tax together cannot be more than the balance
  const short = side === 'sell' && cost !== null && cost > 0 && have !== undefined && n + cost > have;
  const most = bps !== null && have !== undefined ? have / (1 + bps / 10_000) : null;

  return (
    <div className="rounded-lg border border-brass-700/40 bg-ink-900 p-4">
      <div className="flex items-center justify-between gap-3">
        <Tabs value={side} onChange={v => (setSide(v), setAmount(''))} options={[{value: 'buy', label: 'Buy'}, {value: 'sell', label: 'Sell'}]} size="sm" />
        {side === 'buy' && pays.length > 1 && (
          <Tabs value={pay.symbol} onChange={v => (setPay(pays.find(p => p.symbol === v)!), setAmount(''))} options={pays.map(p => ({value: p.symbol, label: `with ${p.symbol}`}))} size="sm" />
        )}
      </div>
      <div className="mt-3">
        <Input
          label={side === 'buy' ? `Pay, in ${pay.symbol}` : `Sell, in ${symbol}`}
          value={amount}
          onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0.0"
          inputMode="decimal"
          mono
          error={tooMuch ? 'More than you have' : undefined}
          hint={have !== undefined ? `You have ${show(have)} ${spending.symbol}` : undefined}
        />
        <div className="mt-2 flex gap-1.5">
          {(side === 'buy' ? [0.1, 0.25, 0.5] : [0.25, 0.5, 0.9]).map(s => (
            <button key={s} type="button" onClick={() => part(s)} className="num rounded border border-ink-800 px-2 py-0.5 text-[11px] text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-100 active:bg-ink-800">
              {s * 100}%
            </button>
          ))}
        </div>
      </div>
      <dl className="num mt-3 flex justify-between gap-3 text-[13px]">
        <dt className="text-ink-500">The pool pays about</dt>
        <dd className="text-ink-100">
          <Flash value={out} tint={false}>
            {out === null ? '—' : `${show(out)} ${side === 'buy' ? symbol : quote.symbol}`}
          </Flash>
        </dd>
      </dl>
      {tax && (
        <dl className="num mt-1.5 space-y-1.5 text-[13px]">
          <div className="flex justify-between gap-3">
            <dt className="text-ink-500">Tax now, buy / sell</dt>
            <dd className="text-ink-100">
              <Flash value={tax.buyBps} tint={false}>
                {tax.buyBps === null ? '—' : `${(tax.buyBps / 100).toFixed(2)}%`}
              </Flash>{' '}
              /{' '}
              <Flash value={tax.sellBps} tint={false}>
                {tax.sellBps === null ? '—' : `${(tax.sellBps / 100).toFixed(2)}%`}
              </Flash>
            </dd>
          </div>
          {cost !== null && (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-500">{side === 'buy' ? 'This buy pays at least' : 'This sale pays at least, on top'}</dt>
              <dd className={cost > 0 ? 'text-brass-300' : 'text-ink-100'}>
                {cost > 0 ? `${show(cost)} ${symbol}` : 'nothing'}
              </dd>
            </div>
          )}
          {kept !== null && cost !== null && cost > 0 && (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-500">You keep about</dt>
              <dd className="text-ink-100">
                {show(kept)} {symbol}
              </dd>
            </div>
          )}
        </dl>
      )}
      {short && most !== null && (
        <p role="alert" className="mt-2 text-[13px] leading-5 text-down-400">
          The tax is taken on top, from what you have left: leave room for it. At this rate the most you can sell is about {show(most)} {symbol}.
        </p>
      )}
      <Button className="mt-3 w-full" loading={busy} disabled={wallet.status === 'connected' && (!amount || !(n > 0) || tooMuch || short)} onClick={go}>
        {wallet.status !== 'connected' ? 'Connect to trade' : side === 'buy' ? `Buy ${symbol}` : `Sell ${symbol}`}
      </Button>
      {side === 'sell' && wallet.status === 'connected' && have !== undefined && have > 0 && (
        <Button variant="secondary" className="mt-2 w-full" loading={busy} onClick={sellMost}>
          Sell the most I can
        </Button>
      )}
      <p className="mt-2.5 text-[12px] leading-snug text-ink-500">
        {rule} The rate shown is the lagging one; a trade also pays for its own push, up to 50%.{' '}
        {side === 'sell' && 'A sale\u2019s tax comes out of what you have left, so you cannot sell your whole balance while the sell tax is on: \u201cSell the most I can\u201d finds the largest sale that goes through. A wallet\u2019s own swap or an aggregator holds the tokens first and has nothing left to pay with, so it reverts. '}
        One swap straight through the pool: a wallet&rsquo;s own swap moves the token three times and pays the repetition fee.
      </p>
    </div>
  );
}
