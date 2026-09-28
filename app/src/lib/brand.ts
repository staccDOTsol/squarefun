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
  standards: {
    eip: {label: 'EIP-12384', url: 'https://github.com/ethereum/EIPs/pull/12384'},
    token2022: {label: 'Token-2022 SlotReferenceFee', url: 'https://github.com/solana-program/token-2022/pull/1508'},
  },
} as const;
