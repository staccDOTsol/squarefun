import {createContext, useCallback, useContext, useEffect, useState, type ReactNode} from 'react';
import {createWalletClient, custom, type Address, type WalletClient} from 'viem';
import {robinhood} from './chain';

type Status = 'disconnected' | 'connecting' | 'connected' | 'wrong-chain' | 'error';

interface WalletState {
  status: Status;
  address?: Address;
  client?: WalletClient;
  error?: string;
  /** true once we looked and found no injected provider (Telegram/Safari on a phone) */
  noWallet?: boolean;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
  disconnect: () => void;
}

const Ctx = createContext<WalletState>({status: 'disconnected', connect: async () => {}, switchChain: async () => {}, disconnect: () => {}});

type Eip1193 = {
  request: (args: {method: string; params?: unknown[]}) => Promise<unknown>;
  on?: (event: string, cb: (...a: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...a: unknown[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

const HEX_CHAIN = `0x${robinhood.id.toString(16)}`;

/**
 * Find a provider. Prefers EIP-6963 announcements (MetaMask, Rabby, Coinbase...), falls back to
 * window.ethereum, and waits a moment for wallets that inject late (MetaMask mobile's browser).
 */
let discovered: Eip1193 | undefined;
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e: Event) => {
    const d = (e as CustomEvent<{info: {rdns: string}; provider: Eip1193}>).detail;
    if (!discovered || /metamask|rabby/i.test(d.info.rdns)) discovered = d.provider;
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
async function getProvider(waitMs = 1500): Promise<Eip1193 | undefined> {
  if (discovered) return discovered;
  if (window.ethereum) return window.ethereum;
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  return new Promise(resolve => {
    const done = () => resolve(discovered ?? window.ethereum);
    window.addEventListener('ethereum#initialized', done, {once: true});
    setTimeout(done, waitMs);
  });
}

export function WalletProvider({children}: {children: ReactNode}) {
  const [status, setStatus] = useState<Status>('disconnected');
  const [address, setAddress] = useState<Address>();
  const [client, setClient] = useState<WalletClient>();
  const [error, setError] = useState<string>();
  const [noWallet, setNoWallet] = useState(false);

  const refresh = useCallback(async () => {
    const eth = await getProvider(0);
    if (!eth) return;
    const accounts = (await eth.request({method: 'eth_accounts'})) as string[];
    if (accounts.length === 0) {
      setStatus('disconnected');
      setAddress(undefined);
      setClient(undefined);
      return;
    }
    const chain = (await eth.request({method: 'eth_chainId'})) as string;
    setAddress(accounts[0] as Address);
    setClient(createWalletClient({chain: robinhood, transport: custom(eth)}));
    setStatus(parseInt(chain, 16) === robinhood.id ? 'connected' : 'wrong-chain');
  }, []);

  useEffect(() => {
    let eth: Eip1193 | undefined;
    const onAccounts = () => refresh();
    const onChain = () => refresh();
    void getProvider().then(p => {
      eth = p;
      if (!eth) {
        setNoWallet(true);
        return;
      }
      setNoWallet(false);
      void refresh();
      eth.on?.('accountsChanged', onAccounts);
      eth.on?.('chainChanged', onChain);
    });
    return () => {
      eth?.removeListener?.('accountsChanged', onAccounts);
      eth?.removeListener?.('chainChanged', onChain);
    };
  }, [refresh]);

  const switchChain = useCallback(async () => {
    const eth = await getProvider(0);
    if (!eth) return;
    try {
      await eth.request({method: 'wallet_switchEthereumChain', params: [{chainId: HEX_CHAIN}]});
    } catch (e) {
      const code = (e as {code?: number}).code;
      if (code === 4902) {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: HEX_CHAIN,
              chainName: robinhood.name,
              nativeCurrency: robinhood.nativeCurrency,
              rpcUrls: robinhood.rpcUrls.default.http,
              blockExplorerUrls: [robinhood.blockExplorers.default.url],
            },
          ],
        });
      } else throw e;
    }
    await refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    setStatus('connecting');
    setError(undefined);
    try {
      const eth = await getProvider(2500);
      if (!eth) {
        setNoWallet(true);
        throw new Error('No wallet in this browser.');
      }
      setNoWallet(false);
      await eth.request({method: 'eth_requestAccounts'});
      await refresh();
      const chain = (await eth.request({method: 'eth_chainId'})) as string;
      if (parseInt(chain, 16) !== robinhood.id) await switchChain();
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Could not connect');
    }
  }, [refresh, switchChain]);

  const disconnect = useCallback(() => {
    setAddress(undefined);
    setClient(undefined);
    setStatus('disconnected');
  }, []);

  return <Ctx.Provider value={{status, address, client, error, noWallet, connect, switchChain, disconnect}}>{children}</Ctx.Provider>;
}

export function useWallet() {
  return useContext(Ctx);
}
