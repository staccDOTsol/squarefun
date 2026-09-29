/** One place to rename the pad and its token. */
export const BRAND = {
  name: 'Square',
  tagline: 'A square deal for every launch on Robinhood Chain.',
  token: 'SQUARE',
  chainName: 'Robinhood Chain',
  chainId: 4663,
  quote: 'ETH',
  explorer: 'https://robinhoodchain.blockscout.com',
  social: {
    x: 'https://x.com/STACCoverflow',
    telegram: 'https://t.me/staccoverflow',
    github: 'https://github.com/staccDOTsol',
  },
  thesis: [
    'Repetition is underpriced.',
    'Here the k-th touch of a token within a block pays 10 bp × k², taken from the transfer.',
    'Half is held by a sink with no owner. Half goes to stakers. Whoever is being priced gets nothing, so nobody has a reason to farm it.',
  ],
  secondaries:
    'Buy on this site, not on secondaries. Pools other people set up on a token pay the square as designed, so they quote much, much worse rates.',
  standards: {
    eip: {label: 'EIP-8429', url: 'https://github.com/ethereum/EIPs/pull/12384'},
    eipDiscussion: {label: 'discussion', url: 'https://ethereum-magicians.org/t/eip-8429-escalating-gas-for-repeated-calls/29798'},
    token2022: {label: 'Token-2022 SlotReferenceFee', url: 'https://github.com/solana-program/token-2022/pull/1508'},
  },
} as const;
