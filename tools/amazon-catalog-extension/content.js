function mountAmazonCatalog(panelStyle) {
  const id = 'bussan-amazon-catalog-panel';
  globalThis.disposeBussanAmazonCatalog?.();
  document.getElementById(id)?.remove();
  const host = document.createElement('div');
  host.id = id;
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(panelStyle);
  root.adoptedStyleSheets = [sheet];

  let currentAsin;
  let view;
  let main;
  let openButton;
  let closed = false;
  let side = 'right';
  let position;
  let layoutRequest;
  let layoutReady = false;
  const onMessage = message => {
    if (message.type === 'catalog-owner-changed') void view?.refresh();
  };
  const sizeObserver = new ResizeObserver(placePanel);
  sizeObserver.observe(host);
  window.addEventListener('resize', placePanel);

  function closePanel() {
    view?.dispose();
    if (chrome.runtime?.id) chrome.runtime.onMessage.removeListener(onMessage);
    host.remove();
    sizeObserver.disconnect();
    window.removeEventListener('resize', placePanel);
    clearInterval(timer);
  }

  function boundedPosition(point) {
    return {
      x: Math.max(0, Math.min(point.x, document.documentElement.clientWidth - host.offsetWidth)),
      y: Math.max(0, Math.min(point.y, document.documentElement.clientHeight - host.offsetHeight)),
    };
  }

  function placePanel() {
    host.classList.toggle('positioned', Boolean(position));
    if (!position) return;
    const point = boundedPosition(position);
    host.style.setProperty('--panel-x', point.x + 'px');
    host.style.setProperty('--panel-y', point.y + 'px');
  }

  function enableDrag(header) {
    let drag;
    header.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || event.target.closest('button, a')) return;
      const box = host.getBoundingClientRect();
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: box.left, y: box.top, moved: false };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      position = boundedPosition({ x: drag.x + dx, y: drag.y + dy });
      placePanel();
    });
    header.addEventListener('lostpointercapture', event => {
      if (drag?.id !== event.pointerId) return;
      const moved = drag.moved;
      drag = undefined;
      if (moved) updatePreference({ type: 'set-panel-position', position });
    });
  }

  function updateLayout() {
    host.classList.toggle('on-left', side === 'left');
    host.classList.toggle('panel-closed', closed);
    main.hidden = closed;
    openButton.hidden = !closed;
    placePanel();
    if (!closed && !view) view = mountCatalogView(root);
  }

  function updatePreference(message) {
    void chrome.runtime.sendMessage(message).catch(() => {});
  }

  function mountPanel() {
    const makeButton = (label, onClick) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', onClick);
      return button;
    };
    main = createCatalogMarkup();
    const header = main.querySelector('header');
    header.querySelector('h1').title = 'ドラッグで移動';
    enableDrag(header);
    const controls = document.createElement('div');
    controls.className = 'panel-controls';
    const closeButton = makeButton('閉じる', () => {
      closed = true;
      updateLayout();
      openButton.focus();
    });
    closeButton.id = 'panel-close';
    controls.append(main.querySelector('#settings'), closeButton);
    header.append(controls);
    openButton = makeButton('商品リストを表示', () => {
      closed = false;
      updateLayout();
      closeButton.focus();
    });
    openButton.className = 'panel-open primary';
    openButton.id = 'panel-show';
    root.replaceChildren(main, openButton);
    updateLayout();
  }

  function syncProduct() {
    if (!chrome.runtime?.id) {
      closePanel();
      return;
    }
    const urlAsin = asinFromUrl(location.href);
    const asin = urlAsin ? readAmazonProduct(urlAsin, true) : null;
    if (asin && !layoutReady) {
      layoutRequest ??= chrome.runtime.sendMessage({ type: 'panel-layout' }).then(response => {
        side = response?.data?.panelSide === 'left' ? 'left' : 'right';
        const saved = response?.data?.panelPosition;
        if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) position = saved;
      }).catch(() => {}).finally(() => {
        layoutReady = true;
        syncProduct();
      });
      return;
    }
    if (asin === currentAsin) {
      if (asin && !host.isConnected) document.documentElement.append(host);
      return;
    }
    currentAsin = asin;
    closed = false;
    view?.dispose();
    view = undefined;
    if (asin) {
      if (!host.isConnected) document.documentElement.append(host);
      mountPanel();
    } else {
      host.remove();
    }
  }
  const timer = setInterval(syncProduct, 750);
  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.disposeBussanAmazonCatalog = closePanel;
  syncProduct();
}
