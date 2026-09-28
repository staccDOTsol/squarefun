import {createContext, useContext, useEffect, useState, type ReactNode} from 'react';

interface RouterState {
  path: string;
  navigate: (to: string) => void;
}

const Ctx = createContext<RouterState>({path: '/', navigate: () => {}});

export function RouterProvider({children}: {children: ReactNode}) {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (to: string) => {
    if (to === path) return;
    window.history.pushState(null, '', to);
    setPath(to);
    window.scrollTo({top: 0});
  };
  return <Ctx.Provider value={{path, navigate}}>{children}</Ctx.Provider>;
}

export function useRouter() {
  return useContext(Ctx);
}

export function Link({
  to,
  className,
  children,
  ...rest
}: {to: string; className?: string; children: ReactNode} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const {navigate} = useRouter();
  return (
    <a
      href={to}
      className={className}
      onClick={e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}>
      {children}
    </a>
  );
}
