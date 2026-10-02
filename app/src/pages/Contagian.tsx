import {upload} from '@vercel/blob/client';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {Address} from 'viem';
import {ActivityBeat, ActivityFeed, LeaderTable, LiveHeading, amt, type LeaderRow} from '../components/Activity';
import {ContagianPayoff} from '../components/ContagianPayoff';
import {Button} from '../components/ui/Button';
import {Input, Textarea} from '../components/ui/Field';
import {ErrorBox, Skeleton, Tabs, toast} from '../components/ui/Bits';
import {Flash} from '../components/ui/Live';
import {useActivity} from '../lib/activity';
import {BRAND} from '../lib/brand';
import {ZERO} from '../lib/chain';
import {
  CONTAGIAN_SUPPLY,
  DEFAULT_DRIP,
  DEFAULT_MULTIPLE,
  USDG,
  contagian,
  contagianDeployed,
  contagianTx,
  defaultPartners,
  ofParity,
  resolvePair,
  span,
  termsFor,
  toAddress,
  type ContagianLaunch,
  type Pair,
} from '../lib/contagian';
import {ago, num, price} from '../lib/format';
import {useContagianLeaders, type TaxBoard} from '../lib/leaders';
import {useLive} from '../lib/live';
import {Link} from '../lib/router';
import {bp, shown, side, useSlow} from './ContagianToken';
import {useWallet} from '../lib/wallet';

/**
 * Row label, SafeMoon, Contagian. `window` is the vault's DRIP in words ("an hour"): how long an
 * entry waits before it earns, and how long a payout takes to be released.
 */
const versus = (window: string): Array<[string, string, string]> => [
  [
    'The tax',
    'A flat 10% on every transfer, buy or sell.',
    'Priced against the peg. Over parity a buy pays, under it a sale pays, and the other side is free. Faster costs more, up to 50%.',
  ],
  [
    'Who pays',
    'Everyone, every time.',
    'Whoever is pushing it away from its peg, and machines: the 3rd transfer in a block and a wallet\u2019s 7th transaction in a week.',
  ],
  [
    'Selling',
    'Taxed 10%.',
    'Under parity a sale is taxed on top: the pool is paid in full and the tax comes out of what the seller has left. Over parity a sale is free.',
  ],
  [
    'Where the tax goes',
    'Half handed to all holders as more of the same token; half sold and paired into liquidity.',
    'Sold on the way up, never down. Half of what it sells for goes to the bad beats, half to holders.',
  ],
  [
    'The reflection',
    'To every holder, in the token itself.',
    `In the memequote, released over ${window}. Half to the wallets that paid the tax, by how much; half to holders, by balance.`,
  ],
  [
    'Who it pays',
    'Whoever is holding.',
    `Whoever was burned before you, and whoever is holding. An entry starts earning ${window} after it is paid, so nobody gets their own tax back.`,
  ],
  [
    'What the liquidity earns',
    'It went with the LP tokens, to the owner\u2019s wallet.',
    `Half to the bad beats, a quarter to the Stacc Wizards, a quarter to ${BRAND.token} stakers.`,
  ],
  ['The liquidity', 'LP tokens went to the owner\u2019s wallet.', 'The launch position is held by a contract with no function to remove it.'],
  [
    'Other assets',
    'None. Its liquidity was paired with BNB only.',
    'Unsold tolls are also offered against ETH and other dollars, and things with a goodish oracle, token-side only, so none of the other asset is at risk.',
  ],
  ['Who can change it', 'An owner could change fees and exempt wallets.', 'No owner, no switches.'],
  [
    'The floor',
    'None.',
    'The launch position: every unit paid in stays until someone sells it back out, and the pool cannot trade under its opening price.',
  ],
  ['The moon', 'Wherever.', 'Its peg. Under it buying is free and selling costs; over it buying costs and selling is free.'],
];

type QuoteKind = 'usdg' | 'eth' | 'custom';
type PegKind = 'same' | 'usdg' | 'eth' | 'custom';
const empty = {
  name: '',
  symbol: '',
  description: '',
  image: '',
  quoteKind: 'usdg' as QuoteKind,
  quoteCustom: '',
  pegKind: 'same' as PegKind,
  pegCustom: '',
  multiple: String(DEFAULT_MULTIPLE),
};

export function Contagian() {
  const wallet = useWallet();
  const [f, setF] = useState(empty);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // the same upload the launch page uses: checked here, hosted on Vercel Blob, the URL goes on-chain
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setUploadErr(null);
    if (!file.type.startsWith('image/')) return setUploadErr('Pick an image');
    if (file.size > 4 * 1024 * 1024) return setUploadErr('At most 4 MB');
    const dims = await new Promise<{w: number; h: number}>(resolve => {
      const img = new Image();
      img.onload = () => resolve({w: img.naturalWidth, h: img.naturalHeight});
      img.onerror = () => resolve({w: 0, h: 0});
      img.src = URL.createObjectURL(file);
    });
    if (dims.w && dims.w < 256) return setUploadErr('At least 256 px wide');
    setUploading(true);
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace('jpeg', 'jpg');
      const slug = (f.symbol || f.name || 'token').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'token';
      const blob = await upload(`launch/${slug}.${ext}`, file, {access: 'public', handleUploadUrl: '/api/upload', contentType: file.type});
      setF(s => ({...s, image: blob.url}));
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<Pair | null>(null);
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [launched, setLaunched] = useState<Address | null>(null);
  const [list, setList] = useState<ContagianLaunch[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);

  const reload = useCallback(async () => setList(await contagian.list()), []);
  const load = useCallback(() => {
    if (!contagianDeployed) return;
    setListErr(null);
    reload().catch(e => setListErr(e instanceof Error ? e.message : 'Could not read the launcher'));
  }, [reload]);
  useEffect(load, [load]);
  // Live: every vault's numbers again every few seconds, and at once when the shared activity read sees something land
  useLive(reload, 5000, contagianDeployed && list !== null);
  const activity = useActivity({family: 'contagian'});
  const tax = useContagianLeaders();
  const newest = activity.events[0]?.id;
  const told = useRef<string | undefined>(undefined);
  useEffect(() => {
    const before = told.current;
    told.current = newest;
    if (before !== undefined && newest !== before) void reload().catch(() => {});
  }, [newest, reload]);

  const quoteAddr = f.quoteKind === 'usdg' ? USDG : f.quoteKind === 'eth' ? ZERO : toAddress(f.quoteCustom);
  const pegAddr = f.pegKind === 'same' ? quoteAddr : f.pegKind === 'usdg' ? USDG : f.pegKind === 'eth' ? ZERO : toAddress(f.pegCustom);

  // both assets and the rate between them, read again whenever either choice changes
  useEffect(() => {
    setPair(null);
    setPairErr(null);
    if (!quoteAddr || !pegAddr) return;
    let live = true;
    resolvePair(quoteAddr, pegAddr)
      .then(p => live && setPair(p))
      .catch(e => live && setPairErr(e instanceof Error ? e.message.split('\n')[0] : 'Could not read those tokens'));
    return () => {
      live = false;
    };
  }, [quoteAddr, pegAddr]);

  const multiple = Number(f.multiple);
  const terms = useMemo(() => (pair ? termsFor(pair, multiple) : null), [pair, multiple]);
  const pegDiffers = !!pair && pair.peg.address.toLowerCase() !== pair.quote.address.toLowerCase();
  const partners = quoteAddr ? defaultPartners(quoteAddr) : [];

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = 'Give it a name';
    else if (f.name.length > 64) e.name = 'At most 64 characters';
    if (!f.symbol.trim()) e.symbol = 'Give it a ticker';
    else if (!/^[A-Za-z0-9]{1,16}$/.test(f.symbol)) e.symbol = 'Letters and digits, up to 16';
    if (f.description.length > 2048) e.description = 'At most 2048 characters';
    if (f.image.length > 512) e.image = 'At most 512 characters';
    if (f.quoteKind === 'custom' && !quoteAddr) e.quoteCustom = 'Paste a token address';
    if (f.pegKind === 'custom' && !toAddress(f.pegCustom)) e.pegCustom = 'Paste a token address';
    if (!(multiple > 1)) e.multiple = 'More than 1';
    else if (pair && !terms) e.multiple = 'Too small or too large for the pool to hold';
    return e;
  }, [f, quoteAddr, multiple, pair, terms]);
  const valid = Object.keys(errors).length === 0;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF(s => ({...s, [k]: e.target.value}));
  const blur = (k: string) => () => setTouched(t => ({...t, [k]: true}));

  const submit = async () => {
    setTouched({name: true, symbol: true, description: true, image: true, quoteCustom: true, pegCustom: true, multiple: true});
    if (!contagianDeployed || !valid || !pair || !terms) return;
    if (wallet.status === 'wrong-chain') return wallet.switchChain();
    if (wallet.status !== 'connected' || !wallet.client || !wallet.address) return wallet.connect();
    setBusy(true);
    try {
      // the opening price is fixed for good, so it is set from the peg's rate at this moment, not the one read when the form loaded
      const fresh = await resolvePair(pair.quote.address, pair.peg.address);
      const now = termsFor(fresh, multiple);
      if (!now || now.openTick !== terms.openTick || fresh.ref.fee !== pair.ref.fee) {
        setPair(fresh);
        toast('The rate moved. Check the new opening price and launch again.', 'warn');
        return;
      }
      const {token} = await contagianTx.launch(wallet.client, wallet.address, {
        name: f.name.trim(),
        symbol: f.symbol.trim().toUpperCase(),
        description: f.description.trim(),
        image: f.image.trim(),
        quote: pair.quote.address,
        // the pool the vault will price the peg from, for good: the one this form read the rate from
        peg: {asset: pair.peg.address, refFee: pair.ref.fee, refSpacing: pair.ref.spacing},
        openTick: terms.openTick,
        ceilingTick: terms.ceilingTick,
      });
      toast(`${f.name.trim()} is launched`);
      setLaunched(token ?? null);
      load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Launch failed';
      toast(msg.split('\n')[0].slice(0, 120), 'err');
    } finally {
      setBusy(false);
    }
  };

  const q = pair?.quote.symbol ?? '';

  // The monitor: launches with their live numbers, what just happened on any of them, and who has paid the most tax.
  // With a launcher it leads the page; without one it sits at the foot, quiet.
  const live = (
    <div className={`${contagianDeployed ? 'mt-8' : 'mt-10'} xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start xl:gap-6`}>
      <section aria-labelledby="launched-h" className="min-w-0">
        <LiveHeading id="launched-h" right={list && list.length > 0 ? <span className="num text-[12px] text-ink-500">{list.length}</span> : undefined}>
          Launched tokens
        </LiveHeading>
        <div className="mt-2">
          {!contagianDeployed ? (
            <p className="rounded-lg border border-ink-800 bg-ink-900 px-3 py-2 text-[13px] leading-5 text-ink-500">
              The Contagian launcher is not deployed yet. Launches are listed here once it is.
            </p>
          ) : listErr ? (
            <ErrorBox title="Could not read the launcher" body={listErr} retry={load} />
          ) : !list ? (
            <div className="space-y-px overflow-hidden rounded-lg border border-ink-800">
              {Array.from({length: 3}, (_, i) => (
                <Skeleton key={i} className="h-[62px] w-full rounded-none" />
              ))}
            </div>
          ) : list.length === 0 ? (
            <p className="rounded-lg border border-ink-800 bg-ink-900 px-3 py-2 text-[13px] leading-5 text-ink-500">
              Nothing launched yet. The first Contagian token launched from the form below shows up here.
            </p>
          ) : (
            <ul className="divide-y divide-ink-850 overflow-hidden rounded-lg border border-ink-800">
              {list.map(l => (
                <li key={l.token}>
                  <Link
                    to={`/t/${l.token}`}
                    className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-ink-900 px-4 py-3 transition-colors duration-150 hover:bg-ink-850 active:bg-ink-800">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink-100">
                        {l.name} <span className="num text-[12px] font-normal text-ink-500">${l.symbol}</span>
                      </p>
                      <p className="num text-[12px] text-ink-500">
                        against {l.quote.symbol} · peg 1 {l.peg.symbol} · {ago(l.launchedAt)} ago
                      </p>
                    </div>
                    <dl className="num grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-4">
                      <div>
                        <dt className="text-ink-500">price</dt>
                        <dd className="text-ink-100">
                          <Flash value={l.spot}>
                            {shown(l.spot, price)} {l.quote.symbol}
                          </Flash>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-ink-500">of parity</dt>
                        <dd className={side(l.spot, l.parity).tone} title={side(l.spot, l.parity).line}>
                          <Flash value={side(l.spot, l.parity).pct}>{shown(side(l.spot, l.parity).pct, ofParity)}</Flash>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-ink-500">tax buy / sell</dt>
                        <dd className="text-ink-100">
                          <Flash value={l.buyBps === null || l.sellBps === null ? null : l.buyBps * 100_000 + l.sellBps} tint={false}>
                            {bp(l.buyBps)} / {bp(l.sellBps)}
                          </Flash>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-ink-500">tolls held</dt>
                        <dd className="text-ink-100">
                          <Flash value={l.tolls} tint={false}>
                            {shown(l.tolls, n => num(n, 2))}
                          </Flash>
                        </dd>
                      </div>
                    </dl>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <aside className="mt-6 space-y-5 xl:mt-0" aria-label="Live">
        <section aria-labelledby="ctg-activity-h">
          <LiveHeading id="ctg-activity-h" right={contagianDeployed ? <ActivityBeat beat={activity.beat} /> : undefined}>
            Activity
          </LiveHeading>
          <div className="mt-2">
            <ActivityFeed {...activity} rows={contagianDeployed ? 8 : 2} empty="Nothing yet. Every gotchya, payout and claim on every Contagian token shows up here as it lands." />
          </div>
        </section>
        <TaxBoards {...tax} trigger={newest} rows={contagianDeployed ? 8 : 2} />
      </aside>
    </div>
  );

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-100">Contagian</h1>
      <p className="measure mt-1.5 text-sm text-ink-400">
        A token standard, not one token: a memecoin that tends to its peg. Whoever launches one names what it trades against
        and what it is trying to be worth one of. Over parity buyers pay and sellers don't; under it sellers pay and buyers
        don't. What the tax sells for goes to the wallets that paid it and to holders.
      </p>

      {contagianDeployed && live}

      <div className="mt-8">
        <ContagianPayoff window={span(list?.[0]?.drip ?? DEFAULT_DRIP)} wizardsBps={list?.[0]?.wizardsBps} stakersBps={list?.[0]?.stakersBps} />
      </div>

      <section aria-labelledby="vs-h" className="mt-8">
        <h2 id="vs-h" className="text-[13px] font-medium uppercase tracking-wide text-ink-500">
          What's this vs SafeMoon
        </h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-ink-800 bg-ink-900">
          <div className="hidden grid-cols-[160px_1fr_1fr] gap-x-6 border-b border-ink-800 px-4 py-2.5 text-[13px] font-medium md:grid" aria-hidden>
            <span />
            <span className="text-ink-400">SafeMoon</span>
            <span className="text-brass-300">Contagian</span>
          </div>
          <dl className="divide-y divide-ink-850">
            {versus(span(list?.[0]?.drip ?? DEFAULT_DRIP)).map(([k, safemoon, ours]) => (
              <div key={k} className="grid gap-x-6 gap-y-2 px-4 py-3 text-sm leading-6 md:grid-cols-[160px_1fr_1fr]">
                <dt className="text-[13px] font-medium text-ink-300 md:font-normal md:text-ink-500">{k}</dt>
                <dd className="text-ink-400">
                  <span className="block text-[12px] text-ink-500 md:sr-only">SafeMoon</span>
                  {safemoon}
                </dd>
                <dd className="text-ink-100">
                  <span className="block text-[12px] text-brass-400 md:sr-only">Contagian</span>
                  {ours}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_380px]">
        <form
          className="space-y-8"
          onSubmit={e => {
            e.preventDefault();
            submit();
          }}
          noValidate>
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-ink-100">Launch a Contagian token</h2>
            <p className="measure mt-1.5 text-sm text-ink-400">
              One transaction makes the token and its vault and puts the whole supply into a Uniswap v4 pool against the
              memequote. No launch fee, no owner, nothing to configure afterwards.
            </p>
          </div>

          <fieldset className="space-y-4">
            <legend className="text-[13px] font-medium uppercase tracking-wide text-ink-500">Identity</legend>
            <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
              <Input label="Name" value={f.name} onChange={set('name')} onBlur={blur('name')} error={touched.name ? errors.name : undefined} placeholder="Name" maxLength={64} />
              <Input label="Ticker" value={f.symbol} onChange={set('symbol')} onBlur={blur('symbol')} error={touched.symbol ? errors.symbol : undefined} placeholder="TICKER" mono maxLength={16} />
            </div>
            <Textarea label="Description" value={f.description} onChange={set('description')} onBlur={blur('description')} error={touched.description ? errors.description : undefined} placeholder="What is this, in one breath." maxLength={2048} hint={`${2048 - f.description.length} left`} />
            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-ink-300">Image</span>
              <div className="flex flex-wrap items-center gap-3">
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" className="sr-only" onChange={e => pick(e.target.files?.[0])} />
                {f.image && <img src={f.image} alt="" className="size-10 rounded-lg border border-ink-800 object-cover" onError={e => ((e.target as HTMLImageElement).style.display = 'none')} />}
                <Button type="button" variant="secondary" loading={uploading} onClick={() => fileRef.current?.click()}>
                  {f.image ? 'Replace image' : 'Upload image'}
                </Button>
                {f.image && (
                  <a href={f.image} target="_blank" rel="noreferrer" className="num max-w-[60%] truncate text-[12px] text-brass-400 hover:underline">
                    {f.image.replace(/^https?:\/\//, '')}
                  </a>
                )}
              </div>
              <span className={`mt-1.5 block text-[13px] ${uploadErr ? 'text-down-400' : 'text-ink-500'}`}>
                {uploadErr ?? 'Square, at least 256 px, up to 4 MB. Hosted on Vercel Blob; the URL is stored on-chain.'}
              </span>
              <details className="mt-2">
                <summary className="cursor-pointer text-[12px] text-ink-500 hover:text-ink-300">or paste a URL</summary>
                <div className="mt-2">
                  <Input value={f.image} onChange={set('image')} onBlur={blur('image')} error={touched.image ? errors.image : undefined} placeholder="https://… (IPFS works)" maxLength={512} aria-label="Image URL" />
                </div>
              </details>
            </div>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-[13px] font-medium uppercase tracking-wide text-ink-500">Memequote and peg</legend>
            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-ink-300">Memequote</span>
              <Tabs
                size="sm"
                value={f.quoteKind}
                onChange={v => setF(s => ({...s, quoteKind: v}))}
                options={[
                  {value: 'usdg', label: 'USDG'},
                  {value: 'eth', label: 'ETH'},
                  {value: 'custom', label: 'Custom'},
                ]}
              />
              <span className="mt-1.5 block text-[13px] text-ink-500">
                What the token trades against. Everything the tax sells for is paid out in it.
              </span>
              {f.quoteKind === 'custom' && (
                <div className="mt-2">
                  <Input label="Memequote token address" value={f.quoteCustom} onChange={set('quoteCustom')} onBlur={blur('quoteCustom')} error={touched.quoteCustom ? errors.quoteCustom : undefined} placeholder="0x…" mono />
                </div>
              )}
            </div>
            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-ink-300">Peg</span>
              <Tabs
                size="sm"
                value={f.pegKind}
                onChange={v => setF(s => ({...s, pegKind: v}))}
                options={[
                  {value: 'same', label: 'Same as the memequote'},
                  {value: 'usdg', label: 'USDG'},
                  {value: 'eth', label: 'ETH'},
                  {value: 'custom', label: 'Custom'},
                ]}
              />
              <span className="mt-1.5 block text-[13px] text-ink-500">What the token is trying to be worth one of.</span>
              {f.pegKind === 'custom' && (
                <div className="mt-2">
                  <Input label="Peg token address" value={f.pegCustom} onChange={set('pegCustom')} onBlur={blur('pegCustom')} error={touched.pegCustom ? errors.pegCustom : undefined} placeholder="0x…" mono />
                </div>
              )}
            </div>
            <div className="max-w-xs">
              <Input
                label="How far from parity it opens"
                value={f.multiple}
                onChange={set('multiple')}
                onBlur={blur('multiple')}
                error={touched.multiple ? errors.multiple : undefined}
                mono
                inputMode="decimal"
                suffix="×"
                hint="Parity today is this many times the opening price."
              />
            </div>
            <p className="measure text-[12px] leading-5 text-ink-500">
              At {DEFAULT_MULTIPLE.toLocaleString()}× a dollar peg opens the 1B supply at about the market cap a Pools instant launch opens
              at.
            </p>
            {pairErr && <ErrorBox title="This pair cannot be launched" body={pairErr} />}
          </fieldset>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button type="submit" size="lg" loading={busy || wallet.status === 'connecting'} disabled={busy || !contagianDeployed || !pair || !terms}>
              {wallet.status === 'wrong-chain' ? `Switch to ${BRAND.chainName}` : wallet.status === 'connected' ? 'Launch' : 'Connect and launch'}
            </Button>
            <p className="text-[13px] text-ink-500">
              {contagianDeployed ? 'One transaction. Gas only.' : 'The Contagian launcher is not deployed yet. Launching opens when it is.'}
            </p>
          </div>

          {launched && (
            <div className="anim-fade rounded-lg border border-up-500/40 bg-ink-900 p-4 text-[13px]">
              <p className="font-medium text-ink-100">Launched</p>
              <p className="num mt-1 break-all text-ink-300">{launched}</p>
              <Link to={`/t/${launched}`} className="mt-2 inline-block text-brass-400 underline-offset-4 hover:underline">
                Open its page
              </Link>
            </div>
          )}
        </form>

        <aside className="space-y-4 lg:sticky lg:top-[72px] lg:self-start">
          <p className="text-[13px] font-medium uppercase tracking-wide text-ink-500">Terms</p>
          <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
            <dl className="num space-y-2 text-[13px]">
              {(
                [
                  ['Supply', `${CONTAGIAN_SUPPLY.toLocaleString()}, all of it in the pool`],
                  ['Trades against', pair ? pair.quote.symbol : null],
                  ['Peg', pair ? `1 ${pair.peg.symbol}` : null],
                  ['Opens at', terms ? `${price(terms.openPrice)} ${q}` : null],
                  ['Parity today', terms ? `${price(terms.parityPrice)} ${q}` : null],
                  ['Opening market cap', terms ? `${num(terms.openPrice * CONTAGIAN_SUPPLY, 2)} ${q}` : null],
                  ['Supply range, in ticks', terms ? `${terms.openTick} to ${terms.ceilingTick}` : null],
                ] as Array<[string, string | null]>
              ).map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3 border-b border-ink-850 pb-1.5">
                  <dt className="text-ink-500">{k}</dt>
                  <dd className="text-right text-ink-200">
                    {v ?? (pairErr || !quoteAddr || !pegAddr || (pair && !terms) ? '—' : <Skeleton className="inline-block h-3 w-20" />)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-[12px] leading-5 text-ink-500">Prices are per token, in the memequote.</p>
          </div>
          <div className="rounded-lg border border-ink-800 bg-ink-900 p-4 text-[13px] leading-5 text-ink-400">
            {pegDiffers && pair ? (
              <p>
                The peg is not the memequote. Parity is one {pair.peg.symbol} per token at whatever {pair.peg.symbol} is worth in{' '}
                {pair.quote.symbol}, read from their {pair.ref.fee / 10_000}% Uniswap v4 pool: {price(pair.pegInQuote)} {pair.quote.symbol} today.
                Parity follows the peg. The opening price does not move.
              </p>
            ) : (
              <p>The peg is the memequote: parity is one {q || 'memequote'} per token.</p>
            )}
            <p className="mt-2">
              {partners.length
                ? `Unsold tolls are also offered against ${partners[0].asset === ZERO ? 'ETH' : 'USDG'}, fixed at launch.`
                : 'Unsold tolls are offered against nothing but the memequote.'}
            </p>
          </div>
        </aside>
      </div>

      {!contagianDeployed && live}
    </main>
  );
}

/**
 * The site-wide bad beats: every vault's `Paid` events summed by wallet, one board per
 * memequote (dollars are not added to ETH). Ranked by tax paid in total; the part of it that is
 * earning is read from the vaults for the rows on screen.
 */
function TaxBoards({boards, status, error, retry, trigger, rows}: ReturnType<typeof useContagianLeaders> & {trigger?: string; rows: number}) {
  const [pick, setPick] = useState<string | null>(null);
  const board: TaxBoard | undefined = boards.find(b => b.quote.address === pick) ?? boards[0];
  const top = (board?.rows ?? []).slice(0, 8).map(r => r.who);
  const slow = useSlow(10_000, top.length > 0);
  const [earning, setEarning] = useState<Record<string, number>>({});
  const sig = `${board?.quote.address}:${top.join()}:${trigger}:${slow}`;
  useEffect(() => {
    // one read a wallet a vault: only while that stays small
    if (!board || top.length === 0 || board.vaults.length > 6) return;
    let on = true;
    contagian
      .earning(board.vaults, top)
      .then(e => on && setEarning(e))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [sig]);
  const list: LeaderRow[] = (board?.rows ?? []).map(r => {
    const e = earning[r.who.toLowerCase()];
    return {...r, note: e === undefined ? undefined : `earning ${amt(e)}`};
  });
  return (
    <section aria-labelledby="ctg-leaders-h">
      <LiveHeading
        id="ctg-leaders-h"
        right={
          boards.length > 1 ? (
            <Tabs size="sm" value={board?.quote.address ?? ''} onChange={setPick} options={boards.map(b => ({value: b.quote.address as string, label: b.quote.symbol}))} />
          ) : undefined
        }>
        Bad beats
      </LiveHeading>
      <div className="mt-2">
        <LeaderTable
          rows={list}
          status={status}
          error={error}
          retry={retry}
          unit={board?.quote.symbol ?? ''}
          show={rows}
          empty="Nobody has been burned yet. The wallets that pay the tax are listed here, and half of what it sells for goes to them."
        />
      </div>
      <p className="mt-1.5 text-[12px] leading-5 text-ink-500">Tax paid in total, by wallet. The other half of every payout goes to holders, by balance.</p>
    </section>
  );
}
