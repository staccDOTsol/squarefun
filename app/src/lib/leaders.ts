import {useMemo, useRef} from 'react';
import type {Address} from 'viem';
import {pump, statusOf, useActivityStore, type VaultInfo} from './activity';
import type {Asset} from './contagian';

/**
 * Leaderboards, from the same remembered log scans as the activity feed (lib/activity.ts), so a
 * board on the page costs no read of its own.
 *
 * Square and Pools tokens: who paid the most in reference fees. Every `Reference(from, to, n, fee)`
 * with a fee, since the pad's deploy block; the payer is `to` when the transfer came out of a venue
 * (the v4 PoolManager or the launch's curve), otherwise `from`.
 *
 * Contagian: who paid the most tax. Every `Paid(originator, tolls, worth)` on a vault, summed by
 * originator, in the memequote. That is the vault's own directory, earning or not yet.
 */

export type Leader = {who: Address; amount: number};

const ranked = (by: Record<string, number> | undefined): Leader[] =>
  Object.entries(by ?? {})
    .map(([who, amount]) => ({who: who as Address, amount}))
    .filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);

/** One token's reference-fee payers, in the token itself. */
export function useSquareLeaders(token: string) {
  const s = useActivityStore();
  const by = s.squareFees[token.toLowerCase()];
  const rows = useMemo(() => ranked(by), [by]);
  return {rows, beat: s.beat, ...statusOf(s, 'square'), retry: () => void pump(true)};
}

/**
 * Every token's reference-fee payers on one board. Fees are paid in the token, and tokens do not
 * add up, so each is valued in ETH at the price given for its token; a token with no price is left out.
 */
export function useSquareLeadersAll(priceEth: Record<string, number>) {
  const s = useActivityStore();
  const rows = useMemo(() => {
    const total: Record<string, number> = {};
    for (const [token, by] of Object.entries(s.squareFees)) {
      const p = priceEth[token];
      if (!p) continue;
      for (const [who, fee] of Object.entries(by)) total[who] = (total[who] ?? 0) + fee * p;
    }
    return ranked(total);
  }, [s.squareFees, priceEth]);
  return {rows, beat: s.beat, ...statusOf(s, 'square'), retry: () => void pump(true)};
}

export type TaxBoard = {quote: Asset; vaults: VaultInfo[]; rows: Leader[]};

/**
 * Tax paid, by originator. With a token, that token's vault alone. Without, every vault, one
 * board per memequote: dollars are not added to ETH.
 */
export function useContagianLeaders(token?: string) {
  const s = useActivityStore();
  const boards = useMemo(() => {
    const want = token?.toLowerCase();
    const groups = new Map<string, TaxBoard & {total: Record<string, number>}>();
    for (const v of s.vaults) {
      if (want && v.token.toLowerCase() !== want) continue;
      const k = v.quote.address.toLowerCase();
      const g = groups.get(k) ?? {quote: v.quote, vaults: [], rows: [], total: {}};
      g.vaults.push(v);
      for (const [who, paid] of Object.entries(s.contagianPaid[v.vault.toLowerCase()] ?? {})) g.total[who] = (g.total[who] ?? 0) + paid;
      groups.set(k, g);
    }
    return [...groups.values()].map(g => ({quote: g.quote, vaults: g.vaults, rows: ranked(g.total)}) as TaxBoard);
  }, [s.vaults, s.contagianPaid, token]);
  return {boards, beat: s.beat, ...statusOf(s, 'contagian'), retry: () => void pump(true)};
}

/**
 * Where each key stood before the order last changed, for a while after it did: the place to pass
 * to `Rank` as `was`. Nothing on the first order, and nothing for a key that was not on the board.
 */
export function useMoves(keys: string[], hold = 12_000) {
  const ref = useRef<{order: string; was: Map<string, number>; places: Map<string, number>; at: number}>({order: '', was: new Map(), places: new Map(), at: 0});
  const order = keys.join();
  if (order !== ref.current.order) {
    const first = ref.current.order === '';
    ref.current = {order, was: first ? new Map() : ref.current.places, places: new Map(keys.map((k, i) => [k, i + 1])), at: Date.now()};
  }
  const live = Date.now() - ref.current.at < hold;
  return (key: string) => (live ? ref.current.was.get(key) : undefined);
}
