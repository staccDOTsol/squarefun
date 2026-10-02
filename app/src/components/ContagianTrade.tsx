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
  onDone,
}: {
  token: Address;
  symbol: string;
  quote: Asset;
  underParity: boolean;
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

  const part = (share: number) => have !== undefined && setAmount(String(Math.floor(have * share * 1e6) / 1e6));
  const rule =
    side === 'buy'
      ? underParity
        ? 'Under parity a buy pays no tax.'
        : 'Over parity a buy pays for its push, in tokens.'
      : underParity
        ? 'Under parity a sale is taxed on top, from what you have left. You cannot sell your whole balance while the tax is on.'
        : 'Over parity a sale pays no tax.';

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
      <Button className="mt-3 w-full" loading={busy} disabled={wallet.status === 'connected' && (!amount || !(n > 0) || tooMuch)} onClick={go}>
        {wallet.status !== 'connected' ? 'Connect to trade' : side === 'buy' ? `Buy ${symbol}` : `Sell ${symbol}`}
      </Button>
      <p className="mt-2.5 text-[12px] leading-snug text-ink-500">
        {rule} One swap straight through the pool: a wallet&rsquo;s own swap moves the token three times and pays the repetition fee.
      </p>
    </div>
  );
}
