import {Header} from './components/Header';
import {ToastRegion} from './components/ui/Bits';
import {Boundary} from './components/ui/Boundary';
import {BRAND} from './lib/brand';
import {RouterProvider, useRouter} from './lib/router';
import {WalletProvider} from './lib/wallet';
import {Board} from './pages/Board';
import {How} from './pages/How';
import {Launch} from './pages/Launch';
import {Migrate, MigrateIndex} from './pages/Migrate';
import {Token} from './pages/Token';
import {Square} from './pages/Square';

function Routes() {
  const {path} = useRouter();
  let page: React.ReactNode;
  if (path === '/') page = <Board />;
  else if (path.startsWith('/t/')) page = <Token address={path.slice(3)} />;
  else if (path === '/launch') page = <Launch />;
  else if (path === '/migrate') page = <MigrateIndex />;
  else if (path.startsWith('/migrate/')) page = <Migrate address={path.slice(9)} />;
  else if (path === '/square') page = <Square />;
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
            {' · '}
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
