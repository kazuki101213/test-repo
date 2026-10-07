import { useEffect, useRef, useState } from 'react';

/** Bound the shared task viewport to four complete shipping rows, including wrapping. */
export function useTaskViewport() {
  const sectionRef = useRef<HTMLElement>(null);
  const shippingRef = useRef<HTMLUListElement>(null);
  const [viewportHeight, setViewportHeight] = useState(400);
  useEffect(() => {
    const section = sectionRef.current;
    const shipping = shippingRef.current;
    if (!section || !shipping) return;
    const measure = () => {
      const rows = Array.from(shipping.querySelectorAll<HTMLElement>('[id^="spare-shipping-"]')).slice(0, 4);
      const style = getComputedStyle(section);
      const bottomInset = parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
      const first = rows[0]?.getBoundingClientRect();
      const last = rows.at(-1)?.getBoundingClientRect();
      if (!first || !last || first.height <= 0) return;
      // With fewer rows, reserve the same capacity without guessing a fixed text height.
      const missingRows = (4 - rows.length) * (last.bottom - first.top) / rows.length;
      const height = Math.ceil(last.bottom - section.getBoundingClientRect().top + section.scrollTop + bottomInset + missingRows);
      setViewportHeight(current => current === height ? current : height);
    };
    const resize = new ResizeObserver(measure);
    const observeRows = () => {
      resize.disconnect();
      resize.observe(shipping);
      shipping.querySelectorAll('[id^="spare-shipping-"]').forEach(row => resize.observe(row));
      measure();
    };
    const mutation = new MutationObserver(observeRows);
    mutation.observe(shipping, { childList: true, subtree: true, characterData: true });
    observeRows();
    window.addEventListener('resize', measure);
    return () => { resize.disconnect(); mutation.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  return { sectionRef, shippingRef, viewportHeight };
}
