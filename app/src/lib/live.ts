import {useEffect, useRef} from 'react';

/**
 * Runs `tick` every `ms` while the tab is visible, at a lazy cadence while it is hidden, never
 * overlapping, and once more the moment the tab comes back. Robinhood blocks every ~250 ms, so a couple of seconds keeps every page current without
 * hammering the RPC.
 */
export function useLive(tick: () => Promise<void> | void, ms = 2500, enabled = true) {
  const fn = useRef(tick);
  fn.current = tick;
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (stop) return;
      if (!busy) {
        busy = true;
        try {
          await fn.current();
        } catch {
          /* transient RPC hiccup: try again next tick */
        } finally {
          busy = false;
        }
      }
      if (!stop) timer = setTimeout(run, document.visibilityState === 'visible' ? ms : Math.max(ms * 6, 15_000));
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    timer = setTimeout(run, ms);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms, enabled]);
}
