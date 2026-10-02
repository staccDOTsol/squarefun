# Contagian

A token standard: a memecoin that tends to its peg. Launched through Uniswap's Liquidity
Launcher (pools.xyz) like every Square token, with a tax measured against parity and paid back
to the people it burned and to the people who held.

Status: live on Robinhood Chain since block 78,447,180 (2026-10-02). Attacked with real
transactions on a fork first (`test/adversarial/attack.mjs`). Not audited.

| Contract | Address | |
| --- | --- | --- |
| `ContagianLauncher` | `0xb649955A1eADe63125e51367115b1638bF9A134e` | one transaction per launch; records every launch |
| `ContagianVault` (implementation) | `0xe9681B6cCe47019E1467E8d7ADE732818E9fDb44` | each launch's vault is a clone of it |
| `ContagianLaunchStrategy` | `0x28d1b307c485b2BBf9F5F06D83759E93a6b62f14` | the Liquidity Launcher strategy |
| `ContagianTokenFactory` | `0x58aAC50568Fc68c95AC34BCCaD003F99BC1D394B` | makes the tokens |

Second version, live since block 78,463,951. All four are exact matches on Sourcify and verified
on Etherscan. Source: `contracts/src/square/contagian/`. The first version (launcher
`0x62924A07935B49b487162b9aabcf7a9C35fc8531`) still stands; its one token is hidden on the site.

First launch: Stable Contagian `0x174E6eEdA35971a1C8FE959B0320d85B9890544d`, vault
`0xE39Eb4cB12717Da97bFba3cc6A0F18364165c205`, USDG as quote and peg.

## The rules

Measured against parity: one of the peg per token, in the memequote the token trades against.

| | |
| --- | --- |
| over parity | buyers pay, sellers don't |
| under parity | sellers pay, buyers don't |
| at parity | move it either way and you pay for the move |
| faster | more, up to 50% |

A trade pays the larger of the speed the token has been leaving parity at and half the gap the
trade itself leaves between the price and its ten-minute average on the wrong side of parity.
A buy pays in kind. A sale pays on top: the pool is paid in full and the tax comes out of what
the seller has left, so a whole balance cannot be sold while the sell tax is on. On top of
that, every transfer carries the two ratchets all Square tokens carry (the third transfer in a
block, a wallet's seventh transaction in a week); a sale pays the weekly one only.

## A launch

`ContagianLauncher.launch(Params)`. Whoever launches names:

- **the memequote**: what the token trades against and what everything is paid out in. `address(0)` is ETH.
- **the peg**: what it is trying to be worth one of, and the hookless v4 pool that prices it in
  the memequote (`refFee` zero when the peg is the memequote). Parity follows that price.
- **`openTick`, `ceilingTick`**: log base 1.0001 of the price the pool opens at and the price the
  supply runs to, in quote units per token unit. Open under parity; run the supply past it.
- **partners**: what unsold tolls are also offered against. Fixed at launch.

The whole 1B supply sits in one v4 position (0.25%, spacing 25, no hook) held by the strategy
for good. Nothing trades under the opening price.

## The tolls

They arrive as tokens and are never sold in a way that pushes the price away from the peg.

The vault runs these itself: every transfer that is not a sale takes one turn (offer, settle,
harvest one range, deepen one partner) and pays out one entry in the directory, if it is at
least three tenths of the average. Anyone can also call them.

| Call | What it does |
| --- | --- |
| `offer()` | puts 5% of the tolls on sale above the price in the launch pool, once an hour |
| `settle()` | while the price is over parity, sells tolls down to it and no further |
| `deepen(i)` | offers 5% against partner `i` in its own pool with the token: token-side only, so none of the partner is at risk. A dollar is priced one for one; anything else by its pool against the quote, the dearer of two readings an hour apart |
| `harvest(from, n)` | collects what sold-through offers sold for, and what the others earned in fees |

Everything the tolls sell for: half to the **bad beats**, half to **holders**, released evenly
over the hour after it arrives, in the memequote.

- The bad beats: the vault is a directory of who paid the tax, each toll entered against
  `tx.origin` at its worth in the quote. An entry starts earning an hour after it is paid, so
  nobody is paid back their own toll.
- The holders: by balance, whoever holds the token outside a pool.

The trading fees the offers earn: 25% Stacc Wizards, 25% SQUARE stakers, 50% bad beats.

Every burn gets a note from the vault (`Gotchya` event, and a zero-gas call carrying the text).

## What the fork run found

`anvil --fork-url <robinhood rpc> --port 8546 --auto-impersonate`, then
`forge build && bun test/adversarial/attack.mjs` (`ONLY=2,13` runs a subset). The public RPC
prunes fork state after about ten minutes: start the fork and run at once.

20 of 21 checks hold. Under parity three $2,000 buys paid nothing, a small sale paid 2.07%, a
dump 8.77%, a sell-everything reverted. Over parity the buy that crossed it paid 7.02% and a
sale paid nothing. An offer sold for $31.38: $15.69 to the bad beats, $15.69 to holders.

Open:

- A round trip netted inside one v4 unlock moves no tokens: no toll, not counted. Only a hook sees it.
- Under parity a buy is free, including for a sniper in the launch block.
- A sale needs spare balance for its tax, and a router that holds the tokens first has none: a
  taxed sale through one reverts.
- **The deployed second version undertaxes sales.** A sale pays only for pushing the price under
  its ten-minute average, so a sale into a pump pays nothing, and the speed is measured as a
  share of parity, so far under parity it is nil. On the live token 43 sales paid nothing. The
  source here is fixed and not deployed: a sale pays for its own move (from the price it found or
  the average, whichever is further), and the speed is the price's own. Fork run: a big sale
  into a pump 21%, a small one 0.12%, a small sale into a slide 24.5%, buys free throughout.
- A partner's price is two spot readings an hour apart.
- An offer of dust still uses up the hour: the first toll on the live token was a few hundred
  wei, so its first real offer came an hour late.
- An offer pays out once the price has run through its whole range; until then it earns fees.
- The same ratchet-fee-on-the-sale-leg defect that Contagian removes is still live on The Cook,
  REALMOON and every SquarePoolsTokenV2 launch: two transfers ahead of a sale in its block revert it.
