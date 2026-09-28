import {BRAND} from '../lib/brand';
import {referenceFeeBps} from '../lib/fee';

/** Learn: one measure column, real reading rhythm, no cards. */
export function How() {
  const rows = [1, 2, 3, 4, 5, 8, 10, 20, 32].map(k => ({k, bps: referenceFeeBps(k)}));
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <article className="measure space-y-6 text-[15px] leading-7 text-ink-200">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-100">How {BRAND.name} works</h1>
        <p>
          A launch on {BRAND.name} is a Pons-style launch on {BRAND.chainName}: the whole supply goes to a bonding curve, anyone
          can buy, and when the curve raises its threshold it sweeps into a full-range Uniswap v4 position that nothing can
          remove. What is different is the token.
        </p>
        <h2 className="pt-2 text-xl font-semibold text-ink-100">The square</h2>
        <p>
          Every token launched here counts its own transfers per block. The first transfer in a block is free. The k-th pays 10
          basis points times k squared, taken in kind from the transfer, capped at 100%. The count is global for the token: it
          does not care who is sending, from which wallet, through which venue, or across how many transactions in the block.
        </p>
        <table className="num w-full max-w-sm text-sm">
          <thead className="text-left text-ink-500">
            <tr>
              <th className="py-1 font-normal">reference in block</th>
              <th className="py-1 text-right font-normal">fee</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.k} className="border-t border-ink-850">
                <td className="py-1">#{r.k}</td>
                <td className="py-1 text-right">{r.bps === 0 ? 'free' : r.bps >= 10_000 ? '100%' : `${r.bps} bp`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          A person buying once pays nothing. A machine that initializes a ladder of pools, adds and removes liquidity around a
          fill, or walks the price through its own venues references the token many times in one block, and pays for every one
          of them after the first. The bigger the machine, the more it pays: the fee grows with the square of its own size.
        </p>
        <h2 className="pt-2 text-xl font-semibold text-ink-100">Where it goes</h2>
        <p>
          Half of every fee goes to a sealed address nobody controls. The other half goes to the {BRAND.name} sink, which pays
          ${BRAND.token} stakers pro rata and the Stacc Wizards fanout. Half is sent to the dead address, where it stays visible and unmovable (supply is unchanged, so it is not a burn in the totalSupply sense). Nothing reaches the party being
          priced.
        </p>
        <h2 className="pt-2 text-xl font-semibold text-ink-100">What is not a reference</h2>
        <p>
          Buying from and selling to the curve. The curve sweeping into the pool. The hook collecting and the vault locking fees.
          The locker holding the position. Those are the token's own plumbing. Everything else, on any venue, counts.
        </p>
        <h2 className="pt-2 text-xl font-semibold text-ink-100">What it does not do</h2>
        <p>
          It does not stop a sandwich: a sandwich is two references, not two hundred, and ordering is the sequencer's job. It
          does not see inside a foreign pool manager's flash accounting. It does not judge what you launch. It prices one
          practice, the same extraction machine run against every launch, because repetition used to be free.
        </p>
        <h2 className="pt-2 text-xl font-semibold text-ink-100">The standards</h2>
        <p>
          The token rule is proposed to Ethereum as a Core EIP, where the client counts calls into an enrolled address per
          block and charges the surcharge in gas:{' '}
          <a href={BRAND.standards.eip.url} className="text-brass-400 underline-offset-4 hover:underline" target="_blank" rel="noreferrer">
            {BRAND.standards.eip.label}
          </a>
          . The same counter is implemented for Solana as a Token-2022 mint extension, where the mint keeps the per-slot count
          and the fee is withheld in kind:{' '}
          <a href={BRAND.standards.token2022.url} className="text-brass-400 underline-offset-4 hover:underline" target="_blank" rel="noreferrer">
            {BRAND.standards.token2022.label}
          </a>
          . What {BRAND.name} ships today is the ERC-20 form, which needs no fork of anything.
        </p>
        <p className="text-ink-500">
          Contracts: a fork of Pons v2's verified sources with one change to the token, plus the sink. All of it is open.
        </p>
      </article>
    </main>
  );
}
