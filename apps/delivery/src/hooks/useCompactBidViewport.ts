import { useEffect, useState } from 'react';

/** Chrome does not expose page zoom to websites. Estimate desktop page zoom
 * from window/layout widths; allow only the narrow 80% band. On mobile or
 * uncertain dimensions keep the normal scrollable layout (never clip it).
 * outerWidth is in screen CSS pixels and is independent of OS display scaling.
 */
export function isCompactBidViewport(outerWidth: number, innerWidth: number, desktop: boolean): boolean {
  if (!desktop || outerWidth <= 0 || innerWidth <= 0) return false;
  const zoom = outerWidth / innerWidth;
  return zoom >= 0.785 && zoom <= 0.825;
}

export function useCompactBidViewport(): boolean {
  const read = () => isCompactBidViewport(window.outerWidth, window.innerWidth, matchMedia('(pointer: fine)').matches);
  const [compact, setCompact] = useState(read);
  useEffect(() => {
    const update = () => setCompact(read());
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    update();
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);
  return compact;
}