import { useEffect, useRef } from 'react';
import { pushBackInterceptor } from '@droid-kit/platform';

/**
 * While `isOpen`, the Android back action calls `close` instead of going back
 * in history, and only for the topmost such overlay. For overlays that have no
 * history entry of their own: popovers, picker panels, confirm dialogs.
 */
export function useCloseOnBack(isOpen: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!isOpen) return;
    return pushBackInterceptor(() => latest.current());
  }, [isOpen]);
}
