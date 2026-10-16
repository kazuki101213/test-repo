import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** Fit the paper to the screen without changing the document's layout. */
export default function DocumentPreview({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ scale: 1, height: 0, left: 0 });
  useLayoutEffect(() => {
    const outer = viewport.current, inner = paper.current;
    if (!outer || !inner) return;
    const update = () => {
      const scale = Math.min(1, outer.clientWidth / inner.offsetWidth);
      const next = { scale, height: inner.offsetHeight * scale, left: Math.max(0, (outer.clientWidth - inner.offsetWidth * scale) / 2) };
      setSize(current => current.scale === next.scale && current.height === next.height && current.left === next.left ? current : next);
    };
    const observer = new ResizeObserver(update);
    observer.observe(outer); observer.observe(inner); update();
    return () => observer.disconnect();
  }, []);
  return <div className="document-preview" ref={viewport} style={{ height: size.height || undefined }}>
    <div className="document-preview-content" ref={paper} style={{ transform: `scale(${size.scale})`, marginLeft: size.left }}>{children}</div>
  </div>;
}
