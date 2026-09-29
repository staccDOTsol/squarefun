import {upload} from '@vercel/blob/client';
import {useMemo, useRef, useState} from 'react';
import {Button} from '../components/ui/Button';
import {Input, Textarea} from '../components/ui/Field';
import {Badge, Empty, toast} from '../components/ui/Bits';
import {ReferenceMeter} from '../components/ReferenceMeter';
import {BRAND} from '../lib/brand';
import {data, tx} from '../lib/data';
import {useRouter} from '../lib/router';
import {poolsDeployed} from '../lib/pools';
import {useWallet} from '../lib/wallet';

const empty = {name: '', symbol: '', description: '', image: '', twitter: '', telegram: '', discord: '', website: '', farcaster: '', };

export function Launch() {
  const wallet = useWallet();
  const {navigate} = useRouter();
  const [f, setF] = useState(empty);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = 'Give it a name';
    else if (f.name.length > 64) e.name = 'At most 64 characters';
    if (!f.symbol.trim()) e.symbol = 'Give it a ticker';
    else if (!/^[A-Za-z0-9]{1,16}$/.test(f.symbol)) e.symbol = 'Letters and digits, up to 16';
    if (f.description.length > 2048) e.description = 'At most 2048 characters';
    if (f.image.length > 512) e.image = 'At most 512 characters';
    for (const k of ['twitter', 'telegram', 'discord', 'website', 'farcaster'] as const) {
      if (f[k].length > 256) e[k] = 'At most 256 characters';
    }
    return e;
  }, [f]);
  const valid = Object.keys(errors).length === 0;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF(s => ({...s, [k]: e.target.value}));
  const blur = (k: string) => () => setTouched(t => ({...t, [k]: true}));

  const submit = async () => {
    setTouched({name: true, symbol: true, description: true, image: true});
    if (!valid) return;
    if (wallet.status === 'wrong-chain') return wallet.switchChain();
    if (wallet.status !== 'connected' || !wallet.client || !wallet.address) return wallet.connect();
    setBusy(true);
    try {
      // the token's on-chain metadata has one link field; the others ride in the description
      const links = [f.twitter.trim(), f.telegram.trim()].filter(Boolean).join(' · ');
      const {token} = await tx.launchViaPools(wallet.client, wallet.address, {
        name: f.name.trim(),
        symbol: f.symbol.trim().toUpperCase(),
        image: f.image.trim(),
        description: [f.description.trim(), links].filter(Boolean).join('\n'),
        website: f.website.trim(),
      });
      toast(`${f.name} is on the board`);
      navigate(token ? `/t/${token}` : '/');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Launch failed';
      toast(msg.split('\n')[0].slice(0, 120), 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!data.deployed || !poolsDeployed) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <Empty title={`${BRAND.name} is not on ${BRAND.chainName} yet`} body="Launches open when the factory is deployed." />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
        <form
          className="space-y-8"
          onSubmit={e => {
            e.preventDefault();
            submit();
          }}
          noValidate>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-100">Launch a token</h1>
            <p className="measure mt-1.5 text-sm text-ink-400">
              No launch fee. The whole supply goes straight into a native-ETH Uniswap v4 pool through Uniswap's Liquidity
              Launcher, the contract behind pools.xyz. There is no curve, the liquidity is locked for good, and aggregators quote
              the pool from the first block.{' '}
              Every token launched here is an EIP-8429 token: the square is on by construction and can never be turned off.
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
            <legend className="text-[13px] font-medium uppercase tracking-wide text-ink-500">Links (optional)</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <Input label="X" value={f.twitter} onChange={set('twitter')} placeholder="https://x.com/…" error={errors.twitter} />
              <Input label="Telegram" value={f.telegram} onChange={set('telegram')} placeholder="https://t.me/…" error={errors.telegram} />
              <Input label="Website" value={f.website} onChange={set('website')} placeholder="https://…" error={errors.website} />
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-[13px] font-medium uppercase tracking-wide text-ink-500">Terms, fixed by the launcher</legend>
            <dl className="num grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
              {[
                ['Supply', '1,000,000,000, all of it in the pool'],
                ['Opens at', 'about 2.5 ETH market cap'],
                ['Pool fee', '0.25% per trade'],
                ['Your share', '40% of the ETH side of pool fees'],
                ['Liquidity', 'locked in Uniswap\u2019s fee splitter, permanently'],
                ['Dev buy', 'none: buy after launch like anyone else'],
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3 border-b border-ink-850 pb-1.5">
                  <dt className="text-ink-500">{k}</dt>
                  <dd className="text-right text-ink-200">{v}</dd>
                </div>
              ))}
            </dl>
          </fieldset>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button type="submit" size="lg" loading={busy || wallet.status === 'connecting'} disabled={busy}>
              {wallet.status === 'wrong-chain' ? `Switch to ${BRAND.chainName}` : wallet.status === 'connected' ? 'Launch' : 'Connect and launch'}
            </Button>
            <p className="text-[13px] text-ink-500">One transaction. Gas only.</p>
          </div>
        </form>

        <aside className="space-y-4 lg:sticky lg:top-[72px] lg:self-start">
          <p className="text-[13px] font-medium uppercase tracking-wide text-ink-500">Preview</p>
          <div className="rounded-lg border border-ink-800 bg-ink-900 p-3">
            <div className="flex gap-3">
              <div className="size-16 shrink-0 overflow-hidden rounded-md bg-ink-800">
                {f.image ? <img src={f.image} alt="" className="size-full object-cover" onError={e => ((e.target as HTMLImageElement).style.display = 'none')} /> : null}
              </div>
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink-100">
                  {f.name || <span className="text-ink-600">Name</span>}{' '}
                  <span className="num text-[12px] font-normal text-ink-500">${f.symbol.toUpperCase() || 'TICKER'}</span>
                </p>
                <p className="truncate text-[13px] text-ink-400">{f.description || <span className="text-ink-600">Description</span>}</p>
                <p className="num mt-2 text-[12px] text-ink-500">by you · now</p>
              </div>
            </div>
            <p className="num mt-3 text-[12px] text-ink-500">pools.xyz · Uniswap v4 · no curve</p>
          </div>
          <div className="rounded-lg border border-ink-800 bg-ink-900 p-4 text-[13px]">
            <p className="font-medium text-ink-200">What your token enforces, forever</p>
            <ul className="mt-2 space-y-1.5 text-ink-400">
              <li className="flex gap-2"><Badge tone="brass">1</Badge> The first two transfers in a block are free, and a wallet's first sixteen in a week.</li>
              <li className="flex gap-2"><Badge tone="brass">2</Badge> After that the k-th pays 10 bp × k², in kind, capped at 100%.</li>
              <li className="flex gap-2"><Badge tone="brass">3</Badge> Fees are sold for ETH: half to a sink nobody controls, half to ${BRAND.token} stakers. Nothing is burned.</li>
              <li className="flex gap-2"><Badge tone="brass">4</Badge> The launch transaction itself is never a reference.</li>
            </ul>
          </div>
          <ReferenceMeter refs={0} freeRefs={2} />
        </aside>
      </div>
    </main>
  );
}
