/**
 * IERC12384 schedule, mirrored from ReferenceFeeERC20.sol.
 * The k-th reference to a token in a block pays FLOOR_BPS * k² basis points,
 * capped at CAP_BPS, with the first K_FREE references free.
 */
export const FLOOR_BPS = 10;
export const CAP_BPS = 10_000;
export const K_FREE = 1;

/** v2 tokens (two ratchets) give two free references per block; v1 gives one. */
export function referenceFeeBps(k: number, freeRefs: 1 | 2 = 1): number {
  if (k <= freeRefs) return 0;
  const r = FLOOR_BPS * k * k;
  return r > CAP_BPS ? CAP_BPS : r;
}

/** Fee on `amount` if it lands as reference `k` in the block. */
export function referenceFee(amount: bigint, k: number, freeRefs: 1 | 2 = 1): bigint {
  return (amount * BigInt(referenceFeeBps(k, freeRefs))) / 10_000n;
}

/** Human summary of the next reference's cost. */
export function nextReferenceLabel(refsSoFar: number, freeRefs: 1 | 2 = 1): string {
  const k = refsSoFar + 1;
  const bps = referenceFeeBps(k, freeRefs);
  if (bps === 0) return 'free';
  if (bps >= CAP_BPS) return '100%';
  return bps % 100 === 0 ? `${bps / 100}%` : `${bps} bp`;
}
