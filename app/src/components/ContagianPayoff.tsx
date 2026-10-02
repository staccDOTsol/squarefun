import type {ReactNode} from 'react';
import {BRAND} from '../lib/brand';

/**
 * "The payoff": who gets what, and what each move costs. Two small tables in the comparison's
 * treatment: aligned columns on a wide screen, each row stacked with its labels on a phone.
 *
 * The fee shares come from the vault's own constants where there is a vault to ask; the numbers
 * here are what they are today, for a page with no vault yet.
 */

/** Columns on a wide screen. Whole class names, so Tailwind sees them. */
const FIVE = 'md:grid-cols-[minmax(0,1.7fr)_repeat(4,minmax(0,1fr))]';
const THREE = 'md:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)]';

function Table({head, rows, cols, mark}: {head: string[]; rows: Array<{k: string; v: ReactNode[]}>; cols: string; mark?: number}) {
  return (
    <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-900">
      <div className={`hidden gap-x-6 border-b border-ink-800 px-4 py-2.5 text-[13px] font-medium md:grid ${cols}`} aria-hidden>
        {head.map((h, i) => (
          <span key={i} className={i === mark ? 'text-brass-300' : i === 0 ? 'text-ink-500' : 'text-ink-400'}>
            {h}
            {i === mark ? ' · now' : ''}
          </span>
        ))}
      </div>
      <dl className="divide-y divide-ink-850">
        {rows.map(r => (
          <div key={r.k} className={`grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 text-sm leading-6 ${cols}`}>
            <dt className="col-span-2 text-[13px] font-medium text-ink-300 md:col-span-1 md:font-normal md:text-ink-500">{r.k}</dt>
            {r.v.map((v, i) => (
              <dd key={i} className={mark === undefined ? 'text-ink-100' : i + 1 === mark ? 'text-ink-100' : 'text-ink-400'}>
                <span className={`block text-[12px] md:sr-only ${i + 1 === mark ? 'text-brass-400' : 'text-ink-500'}`}>
                  {head[i + 1]}
                  {i + 1 === mark ? ' · now' : ''}
                </span>
                {v}
              </dd>
            ))}
          </div>
        ))}
      </dl>
    </div>
  );
}

const share = (bps: number) => <span className="num">{bps === 0 ? '—' : `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(2)}%`}</span>;

export function ContagianPayoff({
  window,
  wizardsBps = 2500,
  stakersBps = 2500,
  now,
  stacked,
}: {
  /** the vault's DRIP in words: "an hour" */
  window: string;
  /** the vault's `WIZARDS_BPS` and `STAKERS_BPS`: the shares of what its offers earn in fees */
  wizardsBps?: number;
  stakersBps?: number;
  /** on a token's page: which side of the peg it is on now, whose column is marked */
  now?: 'under' | 'over' | null;
  /** one table under the other at every width: for a column too narrow for the two side by side */
  stacked?: boolean;
}) {
  return (
    <section aria-labelledby="payoff-h">
      <h2 id="payoff-h" className="text-[13px] font-medium uppercase tracking-wide text-ink-500">
        The payoff
      </h2>
      <div className={`mt-3 grid gap-4 ${stacked ? '' : 'xl:grid-cols-2'}`}>
        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-200">Who gets what</p>
          <Table
            cols={FIVE}
            head={['Money from', 'Bad beats', 'Holders', 'Stacc Wizards', `${BRAND.token} stakers`]}
            rows={[
              {k: 'What the tolls sell for', v: [share(5000), share(5000), share(0), share(0)]},
              {k: 'Trading fees the vault’s offers earn', v: [share(10_000 - wizardsBps - stakersBps), share(0), share(wizardsBps), share(stakersBps)]},
            ]}
          />
          <p className="measure mt-2 text-[12px] leading-5 text-ink-500">
            Bad beats are the wallets that paid the tax, by how much. Everything is paid in the memequote, released over {window}.
          </p>
        </div>
        <div>
          <p className="mb-2 text-[13px] font-medium text-ink-200">What each move costs you</p>
          <Table
            cols={THREE}
            mark={now === 'under' ? 1 : now === 'over' ? 2 : undefined}
            head={['', 'Under the peg', 'Over the peg']}
            rows={[
              {k: 'Buy', v: ['free', <>pays, up to <span className="num">50%</span></>]},
              {k: 'Sell', v: [<>pays on top, up to <span className="num">50%</span></>, 'free']},
              {k: 'Hold', v: ['free, and paid as a holder', 'free, and paid as a holder']},
              {k: 'Trade like a machine', v: ['repetition fee', 'repetition fee']},
            ]}
          />
          <p className="measure mt-2 text-[12px] leading-5 text-ink-500">
            Holding is the only move that never costs. Chasing the price away from the peg always does.
          </p>
        </div>
      </div>
    </section>
  );
}
