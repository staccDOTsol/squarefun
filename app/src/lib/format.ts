export function short(addr: string, n = 4): string {
  return addr.length > 2 * n + 2 ? `${addr.slice(0, 2 + n)}…${addr.slice(-n)}` : addr;
}

export function eth(n: number, digits?: number): string {
  const d = digits ?? (n >= 100 ? 1 : n >= 1 ? 3 : n >= 0.001 ? 4 : 6);
  return `${n.toLocaleString(undefined, {maximumFractionDigits: d})} ETH`;
}

export function num(n: number, digits = 0): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString(undefined, {maximumFractionDigits: digits});
}

export function price(p: number): string {
  if (p === 0) return '0';
  if (p >= 1) return p.toFixed(4);
  const e = Math.floor(Math.log10(p));
  return p.toFixed(Math.min(12, -e + 3));
}

export function pct(n: number, digits = 0): string {
  return `${n.toFixed(digits)}%`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
