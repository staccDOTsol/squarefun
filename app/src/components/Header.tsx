import {useState} from 'react';
import {BRAND} from '../lib/brand';
import {short} from '../lib/format';
import {Link, useRouter} from '../lib/router';
import {useWallet} from '../lib/wallet';
import {Button} from './ui/Button';
import {Mark} from './ui/Bits';

const nav = [
  {to: '/', label: 'Board'},
  {to: '/square', label: `$${BRAND.token}`},
  {to: '/contagian', label: 'Contagian'},
  {to: '/migrate', label: 'Migrate'},
  {to: '/how', label: 'How it works'},
];

export function Header() {
  const {path} = useRouter();
  const wallet = useWallet();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-ink-800/80 bg-ink-950/85 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link to="/" className="group flex items-center gap-2 text-ink-100" aria-label={`${BRAND.name} home`}>
          <Mark className="size-5 text-brass-400 transition-transform group-hover:rotate-45" />
          <span className="font-semibold tracking-tight">{BRAND.name}</span>
          <span className="hidden text-[11px] text-ink-500 sm:inline">on {BRAND.chainName}</span>
        </Link>

        <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Primary">
          {nav.map(n => {
            const active = n.to === '/' ? path === '/' : path.startsWith(n.to);
            return (
              <Link
                key={n.to}
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors duration-150 ${
                  active ? 'bg-ink-850 text-ink-100' : 'text-ink-400 hover:bg-ink-900 hover:text-ink-200'
                }`}>
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link to="/launch" className="hidden sm:block">
            <Button size="sm" variant="primary">
              Launch a token
            </Button>
          </Link>
          {wallet.status === 'connected' && wallet.address ? (
            <Button size="sm" variant="secondary" onClick={wallet.disconnect} title="Disconnect">
              <span className="size-2 rounded-full bg-up-500" />
              <span className="num">{short(wallet.address)}</span>
            </Button>
          ) : wallet.status === 'wrong-chain' ? (
            <Button size="sm" variant="secondary" onClick={wallet.switchChain} className="border-warn-500/50 text-warn-500">
              Switch to {BRAND.chainName}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={wallet.connect} loading={wallet.status === 'connecting'}>
              {wallet.status === 'error' ? 'Retry wallet' : 'Connect'}
            </Button>
          )}
          <button
            className="rounded-md p-2 text-ink-300 hover:bg-ink-900 md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label="Menu"
            onClick={() => setOpen(o => !o)}>
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>
      {open && (
        <nav id="mobile-nav" className="anim-fade border-t border-ink-800 px-4 py-2 md:hidden" aria-label="Primary">
          {[...nav, {to: '/launch', label: 'Launch a token'}].map(n => (
            <Link
              key={n.to}
              to={n.to}
              onClick={() => setOpen(false)}
              className="block rounded-md px-3 py-2.5 text-sm text-ink-200 hover:bg-ink-900">
              {n.label}
            </Link>
          ))}
        </nav>
      )}
      {wallet.status === 'error' && wallet.error && (
        <div role="alert" className="border-t border-down-500/30 bg-down-900/40 px-4 py-2 text-center text-[13px] text-down-400">
          {wallet.noWallet ? <WalletHelp /> : wallet.error}
        </div>
      )}
    </header>
  );
}

/** No injected wallet: this is Telegram's, X's or Safari's browser on a phone. Reopen the page inside a wallet. */
function WalletHelp() {
  const here = window.location.href;
  const bare = here.replace(/^https?:\/\//, '');
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  const copy = () => {
    void navigator.clipboard?.writeText(here);
  };
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
      <span>No wallet in this browser.</span>
      {mobile ? (
        <>
          <a href={`https://metamask.app.link/dapp/${bare}`} className="rounded border border-down-500/40 px-2 py-0.5 text-ink-100 hover:bg-down-900">
            Open in MetaMask
          </a>
          <a href={`https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(here)}`} className="rounded border border-down-500/40 px-2 py-0.5 text-ink-100 hover:bg-down-900">
            Open in Coinbase Wallet
          </a>
          <button onClick={copy} className="rounded border border-down-500/40 px-2 py-0.5 text-ink-100 hover:bg-down-900">
            Copy link
          </button>
          <span className="text-ink-400">or paste it into your wallet's browser</span>
        </>
      ) : (
        <span>Install MetaMask or Rabby, then retry.</span>
      )}
    </div>
  );
}
