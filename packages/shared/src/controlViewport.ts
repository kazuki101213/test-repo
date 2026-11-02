// Use the layout viewport (without the scrollbar) for the shared mobile search width.
if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.documentElement?.clientWidth) {
  const root = document.documentElement;
  if (!root.dataset.controlViewport) {
    root.dataset.controlViewport = 'ready';
    const update = () => {
      const width = `${root.clientWidth}px`;
      if (root.style.getPropertyValue('--control-viewport-width') !== width) root.style.setProperty('--control-viewport-width', width);
    };
    update();
    window.addEventListener('resize', update);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(root);
  }
}
