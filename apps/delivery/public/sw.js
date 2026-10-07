// No offline cache: inventory and account information must remain current.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Always display incoming pushes. */ }
  event.waitUntil(self.registration.showNotification('納品アプリ', {
    body: payload.body || '新しいタスクが追加されました。',
    tag: payload.tag || 'delivery-task',
    icon: new URL('icon-192.png', self.registration.scope).href,
    data: { itemId: payload.itemId },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(self.registration.scope);
  if (/^[0-9a-f-]{36}$/i.test(event.notification.data?.itemId || '')) {
    url.searchParams.set('itemId', event.notification.data.itemId);
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.navigate(url.href);
      return existing.focus();
    }
    return self.clients.openWindow(url.href);
  })());
});
