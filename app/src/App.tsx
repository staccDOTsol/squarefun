import {useCallback, useEffect, useState} from 'react';
import {SiteTicker} from './components/Activity';
import {Header} from './components/Header';
import {ErrorBox, Skeleton, ToastRegion} from './components/ui/Bits';
import {Boundary} from './components/ui/Boundary';
import {BRAND} from './lib/brand';
import {contagian, contagianDeployed, toAddress} from './lib/contagian';
import {RouterProvider, useRouter} from './lib/router';
import {WalletProvider} from './lib/wallet';
import {Board} from './pages/Board';
import {Contagian} from './pages/Contagian';
import {ContagianToken} from './pages/ContagianToken';
import {How} from './pages/How';
import {Launch} from './pages/Launch';
import {Migrate, MigrateIndex} from './pages/Migrate';
import {Token} from './pages/Token';
import {Square} from './pages/Square';

/**
 * A token's page, whatever launched it. The Contagian launchers are asked whether the token is
 * theirs (one read each, none for a token already seen); if so it gets the Contagian page, and
 * anything else gets the page every other launch has. A hidden Contagian token is nobody's, so
 * it lands on that page's "no launch at that address".
 */
function TokenPage({address}: {address: string}) {
  const token = toAddress(address);
  const ask = contagianDeployed && !!token;
  const [kind, setKind] = useState<'contagian' | 'square' | null>(ask ? null : 'square');
  const [err, setErr] = useState<string | null>(null);
  const decide = useCallback(() => {
    if (!ask) return;
    setErr(null);
    contagian
      .is(token)
      .then(yes => setKind(yes ? 'contagian' : 'square'))
      .catch(e => setErr(e instanceof Error ? e.message.split('\n')[0] : 'Could not read the chain'));
  }, [ask, token]);
  useEffect(decide, [decide]);
  if (err) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <ErrorBox title="Could not read the chain" body={err} retry={decide} />
      </main>
    );
  }
  if (!kind) {
    // the header row both pages open with, so nothing jumps when the answer comes
    return (
      <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        <Skeleton className="h-10 w-full max-w-2xl" />
        <div className="mt-4 flex items-center gap-4">
          <Skeleton className="size-8" />
          <Skeleton className="h-5 w-40" />
        </div>
        <Skeleton className="mt-4 h-72 w-full" />
      </main>
    );
  }
  return kind === 'contagian' ? <ContagianToken address={address} /> : <Token address={address} />;
}

function Routes() {
  const {path} = useRouter();
  let page: React.ReactNode;
  if (path === '/') page = <Board />;
  else if (path.startsWith('/t/')) page = <TokenPage address={path.slice(3)} />;
  else if (path === '/launch') page = <Launch />;
  else if (path === '/migrate') page = <MigrateIndex />;
  else if (path.startsWith('/migrate/')) page = <Migrate address={path.slice(9)} />;
  else if (path === '/square') page = <Square />;
  else if (path === '/contagian') page = <Contagian />;
  // the old address of a Contagian token's page: the same page
  else if (path.startsWith('/contagian/')) page = <TokenPage address={path.slice(11)} />;
  else if (path === '/how') page = <How />;
  else page = <Board />;
  return (
    <div key={path} className="anim-fade pb-20 lg:pb-0">
      <Boundary resetKey={path}>{page}</Boundary>
    </div>
  );
}

export function App() {
  return (
    <RouterProvider>
      <WalletProvider>
        <div className="min-h-dvh">
          <Header />
          <SiteTicker />
          <Routes />
          <footer className="mx-auto max-w-7xl px-4 py-10 text-[12px] text-ink-600 sm:px-6">
            {BRAND.name} on {BRAND.chainName} · every rig pays the square ·{' '}
            <a href={BRAND.social.github} className="hover:text-ink-300" target="_blank" rel="noreferrer">
              source
            </a>
            {' · '}
            <a href={BRAND.standards.eip.url} className="hover:text-ink-300" target="_blank" rel="noreferrer">
              {BRAND.standards.eip.label}
            </a>
            {' ('}
            <a href={BRAND.standards.eipDiscussion.url} className="hover:text-ink-300" target="_blank" rel="noreferrer">
              {BRAND.standards.eipDiscussion.label}
            </a>
            {') · '}
            <a href={BRAND.standards.token2022.url} className="hover:text-ink-300" target="_blank" rel="noreferrer">
              {BRAND.standards.token2022.label}
            </a>
          </footer>
        </div>
        <ToastRegion />
      </WalletProvider>
    </RouterProvider>
  );
}
