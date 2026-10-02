import type {Address} from 'viem';
import {ago, num, short} from '../lib/format';
import type {Trade} from '../lib/types';
import {Skeleton} from './ui/Bits';
import {useArrivals} from './ui/Live';

/**
 * A token's latest trades, newest first. Amounts are in `quote`: ETH for curve and Pools tokens,
 * the memequote for a Contagian token. `whoOf` names the wallet behind a trade when the page
 * knows better than the log does (a pool swap's own sender is a router).
 */
export function TradesTable({
  trades,
  symbol,
  explorer,
  quote = 'ETH',
  whoOf,
  empty = 'No trades in the last few hours.',
}: {
  trades: Trade[] | null;
  symbol: string;
  explorer: string;
  quote?: string;
  whoOf?: (t: Trade) => Address | undefined;
  empty?: string;
}) {
  const rows = [...(trades ?? [])].reverse().slice(0, 50);
  const arrival = useArrivals(
    rows.map(t => t.tx + t.side + t.tokens),
    trades !== null,
  );
  // a trade in the top tenth of the ones on screen is jolted as it lands
  const sizes = rows.map(t => t.quote).sort((a, b) => a - b);
  const bar = sizes.length >= 10 ? sizes[Math.floor(sizes.length * 0.9)] : Infinity;
  if (!trades) return <Skeleton className="h-40 w-full" />;
  if (trades.length === 0) return <p className="py-8 text-center text-sm text-ink-500">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-800">
      <table className="num w-full text-[13px]">
        <thead className="bg-ink-900 text-left text-ink-500">
          <tr>
            <th className="px-3 py-2 font-normal">when</th>
            <th className="px-3 py-2 font-normal">side</th>
            <th className="px-3 py-2 text-right font-normal">{quote}</th>
            <th className="px-3 py-2 text-right font-normal">{symbol}</th>
            <th className="px-3 py-2 text-right font-normal">fee</th>
            <th className="px-3 py-2 font-normal">who</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(t => (
            <tr key={t.tx + t.side + t.tokens} className={`border-t border-ink-850 hover:bg-ink-900 ${arrival(t.tx + t.side + t.tokens, t.quote >= bar)}`}>
              <td className="px-3 py-1.5 text-ink-500">
                <a href={`${explorer}/tx/${t.tx}`} target="_blank" rel="noreferrer" className="hover:text-ink-200">
                  {ago(t.ts)}
                </a>
              </td>
              <td className={`px-3 py-1.5 ${t.side === 'buy' ? 'text-up-400' : 'text-down-400'}`}>{t.side}</td>
              <td className="px-3 py-1.5 text-right text-ink-200">{t.quote.toFixed(4)}</td>
              <td className="px-3 py-1.5 text-right text-ink-300">{num(t.tokens)}</td>
              <td className="px-3 py-1.5 text-right text-ink-500">{t.fee.toFixed(5)}</td>
              <td className="px-3 py-1.5 text-ink-500">{short(whoOf?.(t) ?? t.who, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
