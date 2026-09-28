import type {VercelRequest, VercelResponse} from '@vercel/node';
import {card, fmtEth, isAddress} from './_chain.js';

const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[ch]!);

/**
 * Crawler-facing HTML for deep links. vercel.json routes bot user agents on
 * /t/:token here; humans get the SPA. Every value comes from the chain and the
 * image URL carries the block number, so nothing stale is ever cached.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'squarefun.xyz';
  const origin = `https://${host}`;
  const raw = req.query.token;
  const token = Array.isArray(raw) ? raw[0] : raw ?? null;
  const c = isAddress(token) ? await card(token).catch(() => null) : null;

  const path = c ? `/t/${c.token}` : '/';
  const title = c ? `${c.name} ($${c.symbol}) on Square` : 'Square';
  const graduated = c && c.phase !== 0;
  const desc = c
    ? `${graduated ? 'Graduated' : `${Math.min(100, c.threshold ? (c.raised / c.threshold) * 100 : 0).toFixed(0)}% to graduation`} · mc ${fmtEth(c.marketCapEth)} · ${c.refs} references this block. ${c.description.slice(0, 120)}`
    : 'A square deal for every launch on Robinhood Chain. The k-th reference in a block pays k squared.';
  const image = c ? `${origin}/api/og?token=${c.token}&v=${c.block}` : `${origin}/og.png?v=1`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${origin}${path}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Square">
<meta property="og:url" content="${origin}${path}"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@STACCoverflow">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${image}">
<meta http-equiv="refresh" content="0;url=${path}">
</head><body><a href="${path}">${esc(title)}</a></body></html>`;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
  res.status(200).send(html);
}
