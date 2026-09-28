import type {VercelRequest, VercelResponse} from '@vercel/node';
import {Resvg} from '@resvg/resvg-js';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import satori from 'satori';
import {card, fmtEth, isAddress} from './_chain.js';

const font = (file: string) => readFileSync(join(process.cwd(), 'brand/fonts', file));
const fonts = [
  {name: 'Space Grotesk', data: font('SpaceGrotesk.ttf'), weight: 700 as const, style: 'normal' as const},
  {name: 'Space Grotesk', data: font('SpaceGroteskMedium.ttf'), weight: 500 as const, style: 'normal' as const},
  {name: 'JetBrains Mono', data: font('JetBrainsMono.ttf'), weight: 400 as const, style: 'normal' as const},
];

class ImageResponse {
  constructor(private element: React.ReactNode, private opts: {width: number; height: number}) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    const svg = await satori(this.element as React.ReactElement, {width: this.opts.width, height: this.opts.height, fonts});
    const png = new Resvg(svg, {fitTo: {mode: 'width', value: this.opts.width}}).render().asPng();
    return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  }
}

const BG = '#141210';
const INK = '#f3efe7';
const MUTED = '#b9b1a3';
const DIM = '#7c7466';
const BRASS = '#e2a83a';

const markPng = `data:image/png;base64,${readFileSync(join(process.cwd(), 'brand/mark-alpha.png')).toString('base64')}`;

function Mark({size}: {size: number}) {
  return <img src={markPng} width={size} height={size} />;
}

async function send(res: VercelResponse, image: ImageResponse) {
  const buf = Buffer.from(await image.arrayBuffer());
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.status(200).send(buf);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const raw = req.query.token;
  const token = Array.isArray(raw) ? raw[0] : raw ?? null;
  const c = isAddress(token) ? await card(token).catch(() => null) : null;

  if (!c) {
    return send(res, new ImageResponse(
      (
        <div style={{width: 1200, height: 630, background: BG, display: 'flex', alignItems: 'center', padding: '0 96px', fontFamily: 'Space Grotesk'}}>
          <Mark size={280} />
          <div style={{display: 'flex', flexDirection: 'column', marginLeft: 56}}>
            <div style={{fontSize: 128, fontWeight: 700, color: INK, letterSpacing: -4, lineHeight: 1}}>Square</div>
            <div style={{fontSize: 40, color: MUTED, marginTop: 20}}>A square deal for every launch</div>
            <div style={{fontSize: 40, color: MUTED}}>on Robinhood Chain.</div>
            <div style={{fontSize: 26, color: BRASS, marginTop: 40, fontFamily: 'JetBrains Mono'}}>the k-th reference in a block pays k²</div>
          </div>
        </div>
      ),
      {width: 1200, height: 630},
    ));
  }

  const graduated = c.phase !== 0;
  const progress = graduated ? 100 : Math.min(100, c.threshold ? (c.raised / c.threshold) * 100 : 0);
  const next = c.refs === 0 ? 'free' : `${Math.min(10_000, 10 * (c.refs + 1) ** 2)} bp`;

  return send(res, new ImageResponse(
    (
      <div style={{width: 1200, height: 630, background: BG, display: 'flex', flexDirection: 'column', padding: 64, fontFamily: 'Space Grotesk'}}>
        <div style={{display: 'flex', alignItems: 'center'}}>
          <Mark size={56} />
          <div style={{fontSize: 28, color: INK, fontWeight: 700, marginLeft: 8}}>Square</div>
          <div style={{fontSize: 22, color: DIM, marginLeft: 16}}>on Robinhood Chain</div>
          <div style={{marginLeft: 'auto', fontSize: 22, color: graduated ? BRASS : MUTED, border: `2px solid ${graduated ? BRASS : '#3a352d'}`, borderRadius: 999, padding: '6px 18px'}}>
            {graduated ? 'graduated' : 'on the curve'}
          </div>
        </div>
        <div style={{display: 'flex', alignItems: 'center', marginTop: 44}}>
          {c.image ? (
            <img src={c.image} width={200} height={200} style={{borderRadius: 24, objectFit: 'cover', background: '#221f1a'}} />
          ) : (
            <div style={{width: 200, height: 200, borderRadius: 24, background: '#221f1a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: DIM, fontSize: 48, fontFamily: 'JetBrains Mono'}}>
              {c.symbol.slice(0, 3)}
            </div>
          )}
          <div style={{display: 'flex', flexDirection: 'column', marginLeft: 40, maxWidth: 820}}>
            <div style={{display: 'flex', alignItems: 'baseline'}}>
              <div style={{fontSize: 72, fontWeight: 700, color: INK, letterSpacing: -2, lineHeight: 1.05}}>{c.name}</div>
              <div style={{fontSize: 32, color: DIM, marginLeft: 18, fontFamily: 'JetBrains Mono'}}>${c.symbol}</div>
            </div>
            <div style={{fontSize: 28, color: MUTED, marginTop: 12, lineHeight: 1.3}}>{c.description.slice(0, 110)}</div>
          </div>
        </div>
        <div style={{display: 'flex', marginTop: 'auto', alignItems: 'flex-end'}}>
          <div style={{display: 'flex', flexDirection: 'column', width: 620}}>
            <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 22, color: MUTED}}>
              <span>{graduated ? 'Graduated' : 'Curve progress'}</span>
              <span style={{fontFamily: 'JetBrains Mono', color: INK}}>
                {c.raised.toFixed(2)} / {c.threshold} ETH · {progress.toFixed(0)}%
              </span>
            </div>
            <div style={{display: 'flex', height: 12, background: '#2a2620', borderRadius: 999, marginTop: 10}}>
              <div style={{width: `${progress}%`, height: 12, background: graduated ? '#4fce7a' : BRASS, borderRadius: 999}} />
            </div>
          </div>
          <div style={{display: 'flex', marginLeft: 'auto', fontFamily: 'JetBrains Mono', fontSize: 22}}>
            <div style={{display: 'flex', flexDirection: 'column', marginRight: 36}}>
              <span style={{color: DIM}}>market cap</span>
              <span style={{color: INK}}>{fmtEth(c.marketCapEth)}</span>
            </div>
            <div style={{display: 'flex', flexDirection: 'column', marginRight: 36}}>
              <span style={{color: DIM}}>square paid</span>
              <span style={{color: BRASS}}>{c.squarePaid.toFixed(0)} {c.symbol}</span>
            </div>
            <div style={{display: 'flex', flexDirection: 'column'}}>
              <span style={{color: DIM}}>this block</span>
              <span style={{color: c.refs >= 2 ? '#e0644b' : INK}}>{c.refs} refs · next {next}</span>
            </div>
          </div>
        </div>
      </div>
    ),
    {width: 1200, height: 630},
  ));
}
