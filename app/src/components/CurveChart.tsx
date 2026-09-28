import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import {useEffect, useMemo, useRef, useState} from 'react';
import {price as fmtPrice} from '../lib/format';
import type {Trade} from '../lib/types';

/** Candle sizes in seconds. Robinhood blocks are ~250 ms, so a minute already holds many trades. */
const FRAMES = [
  {label: '1m', s: 60},
  {label: '5m', s: 300},
  {label: '15m', s: 900},
  {label: '1h', s: 3600},
  {label: '4h', s: 14_400},
] as const;

/* Canvas cannot take Tailwind tokens; these mirror the oklch palette in index.css. */
const C = {
  bg: '#181715',
  grid: '#24221f',
  border: '#2c2a26',
  text: '#8f8a82',
  brass: '#e3a63a',
  up: '#4fd58f',
  down: '#ee6650',
  volUp: 'rgba(79, 213, 143, 0.35)',
  volDown: 'rgba(238, 102, 80, 0.35)',
};

type Candle = {time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number; buys: number; sells: number};

function bucket(trades: Trade[], size: number): Candle[] {
  const valid = [...trades].filter(t => t.price > 0).sort((a, b) => a.ts - b.ts || Number(a.block - b.block));
  const out: Candle[] = [];
  let last: Candle | null = null;
  for (const t of valid) {
    const time = (Math.floor(t.ts / 1000 / size) * size) as UTCTimestamp;
    if (!last || last.time !== time) {
      // open at the previous close so the path stays continuous across empty buckets
      const open: number = last ? last.close : t.price;
      last = {time, open, high: Math.max(open, t.price), low: Math.min(open, t.price), close: t.price, volume: 0, buys: 0, sells: 0};
      out.push(last);
    }
    last.high = Math.max(last.high, t.price);
    last.low = Math.min(last.low, t.price);
    last.close = t.price;
    last.volume += t.quote;
    if (t.side === 'buy') last.buys += 1;
    else last.sells += 1;
  }
  return out;
}

/** The price path drawn from the curve's own trades, as candles. Nothing synthetic. */
export function CurveChart({trades, symbol}: {trades: Trade[]; symbol: string}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const line = useRef<ISeriesApi<'Line'> | null>(null);
  const [frame, setFrame] = useState<(typeof FRAMES)[number]['s']>(() => {
    try {
      const v = Number(localStorage.getItem('square.frame'));
      return FRAMES.some(f => f.s === v) ? (v as (typeof FRAMES)[number]['s']) : 300;
    } catch {
      return 300;
    }
  });
  const [mode, setMode] = useState<'candles' | 'line'>(() => {
    try {
      return localStorage.getItem('square.chart') === 'line' ? 'line' : 'candles';
    } catch {
      return 'candles';
    }
  });
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  const series = useMemo(() => bucket(trades, frame), [trades, frame]);
  const hover = useMemo(() => (hoverTime === null ? null : series.find(s => s.time === hoverTime) ?? null), [series, hoverTime]);
  const valid = useMemo(() => trades.filter(t => t.price > 0), [trades]);

  useEffect(() => {
    try {
      localStorage.setItem('square.frame', String(frame));
      localStorage.setItem('square.chart', mode);
    } catch {
      /* private mode */
    }
  }, [frame, mode]);

  // Build the chart once the host exists and there is something to draw.
  useEffect(() => {
    const el = host.current;
    if (!el || valid.length === 0) return;
    const c = createChart(el, {
      autoSize: true,
      layout: {
        background: {type: ColorType.Solid, color: C.bg},
        textColor: C.text,
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {vertLines: {color: C.grid, style: 1}, horzLines: {color: C.grid, style: 1}},
      crosshair: {mode: CrosshairMode.Normal, vertLine: {color: C.border, labelBackgroundColor: C.border}, horzLine: {color: C.border, labelBackgroundColor: C.border}},
      rightPriceScale: {borderColor: C.border, scaleMargins: {top: 0.08, bottom: 0.26}},
      timeScale: {borderColor: C.border, timeVisible: true, secondsVisible: false, rightOffset: 2, barSpacing: 10, minBarSpacing: 3},
      handleScale: {axisPressedMouseMove: true, mouseWheel: true, pinch: true},
      handleScroll: {pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false},
      localization: {priceFormatter: (p: number) => fmtPrice(p)},
    });
    const cs = c.addSeries(CandlestickSeries, {
      upColor: C.up,
      downColor: C.down,
      borderUpColor: C.up,
      borderDownColor: C.down,
      wickUpColor: C.up,
      wickDownColor: C.down,
      priceFormat: {type: 'price', precision: 12, minMove: 1e-12},
      priceLineColor: C.brass,
      priceLineWidth: 1,
      lastValueVisible: true,
    });
    const ls = c.addSeries(LineSeries, {
      color: C.brass,
      lineWidth: 2,
      priceFormat: {type: 'price', precision: 12, minMove: 1e-12},
      priceLineColor: C.brass,
      crosshairMarkerRadius: 4,
    });
    const vs = c.addSeries(HistogramSeries, {priceFormat: {type: 'volume'}, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false});
    c.priceScale('vol').applyOptions({scaleMargins: {top: 0.8, bottom: 0}, borderVisible: false});
    c.subscribeCrosshairMove(p => {
      setHoverTime(typeof p.time === 'number' ? p.time : null);
    });
    chart.current = c;
    candles.current = cs;
    volume.current = vs;
    line.current = ls;
    return () => {
      c.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
      line.current = null;
    };
  }, [valid.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Feed data. A frame change resets the series and refits; new trades update the last bars in place
  // so the viewport the reader chose stays put.
  const painted = useRef<{frame: number; len: number} | null>(null);
  useEffect(() => {
    const cs = candles.current;
    const vs = volume.current;
    const ls = line.current;
    const c = chart.current;
    if (!cs || !vs || !ls || !c) return;
    const bar = (s: Candle) => ({time: s.time, open: s.open, high: s.high, low: s.low, close: s.close});
    const vol = (s: Candle) => ({time: s.time, value: s.volume, color: s.close >= s.open ? C.volUp : C.volDown});
    const p = painted.current;
    if (!p || p.frame !== frame || p.len > series.length) {
      cs.setData(series.map(bar));
      ls.setData(series.map(({time, close}) => ({time, value: close})));
      vs.setData(series.map(vol));
      c.timeScale().fitContent();
    } else {
      // only the bucket that was last, plus any new ones, can have changed
      for (let i = Math.max(0, p.len - 1); i < series.length; i++) {
        cs.update(bar(series[i]));
        ls.update({time: series[i].time, value: series[i].close});
        vs.update(vol(series[i]));
      }
    }
    painted.current = {frame, len: series.length};
    cs.applyOptions({visible: mode === 'candles'});
    ls.applyOptions({visible: mode === 'line'});
  }, [series, mode, frame]);

  if (valid.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-ink-700 px-6 text-center text-sm text-ink-500">
        No trades yet. The first one lights the chart.
      </div>
    );
  }

  const lastC = series[series.length - 1];
  const firstC = series[0];
  const shown = hover ?? lastC;
  const change = firstC.open ? ((lastC.close - firstC.open) / firstC.open) * 100 : 0;
  const hoverChange = shown.open ? ((shown.close - shown.open) / shown.open) * 100 : 0;

  return (
    <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-900">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pt-2.5 sm:px-4">
        <span className="num text-lg font-medium text-ink-100">{fmtPrice(shown.close)} ETH</span>
        <span className={`num text-sm ${(hover ? hoverChange : change) >= 0 ? 'text-up-400' : 'text-down-400'}`}>
          {(hover ? hoverChange : change) >= 0 ? '+' : ''}
          {(hover ? hoverChange : change).toFixed(1)}%
        </span>
        <span className="hidden text-[12px] text-ink-500 sm:inline">
          {symbol} per unit · {valid.length} curve trades
        </span>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Candle size">
          {FRAMES.map(f => (
            <button
              key={f.s}
              type="button"
              onClick={() => setFrame(f.s)}
              aria-pressed={frame === f.s}
              className={`num h-7 rounded px-2 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-500 ${
                frame === f.s ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:text-ink-200'
              }`}>
              {f.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-ink-800" />
          {(['candles', 'line'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              title={m === 'candles' ? 'Candles' : 'Line'}
              className={`h-7 rounded px-2 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-500 ${
                mode === m ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:text-ink-200'
              }`}>
              {m === 'candles' ? '▮' : '⟋'}
            </button>
          ))}
        </div>
      </div>
      <div className="num flex flex-wrap gap-x-3 px-3 pt-1 text-[11px] text-ink-500 sm:px-4">
        <span>
          O <span className="text-ink-300">{fmtPrice(shown.open)}</span>
        </span>
        <span>
          H <span className="text-ink-300">{fmtPrice(shown.high)}</span>
        </span>
        <span>
          L <span className="text-ink-300">{fmtPrice(shown.low)}</span>
        </span>
        <span>
          C <span className="text-ink-300">{fmtPrice(shown.close)}</span>
        </span>
        <span>
          vol <span className="text-ink-300">{shown.volume.toFixed(4)} ETH</span>
        </span>
        <span>
          <span className="text-up-400">{shown.buys} buy</span> · <span className="text-down-400">{shown.sells} sell</span>
        </span>
      </div>
      <div ref={host} className="mt-2 h-72 w-full touch-pan-y sm:h-80" role="img" aria-label={`Price of ${symbol} over ${valid.length} trades`} />
    </div>
  );
}
