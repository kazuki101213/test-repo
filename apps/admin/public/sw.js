// Task data stays online; do not cache authenticated app responses.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Show every incoming push. */ }
  event.waitUntil(self.registration.showNotification('管理アプリ', {
    body: payload.body || '新しいタスクが追加されました。', tag: payload.tag || 'admin-task',
    icon: new URL('icon-192.png', self.registration.scope).href,
    data: { kind: payload.kind, itemId: payload.itemId, taskId: payload.taskId, invoiceStaffId: payload.invoiceStaffId, billingMonth: payload.billingMonth },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {}, url = new URL(self.registration.scope);
  if (['malfunction','action','photo_review','invoice','receipts'].includes(data.kind)) url.searchParams.set('taskKind', data.kind);
  for (const key of ['itemId','taskId','invoiceStaffId']) {
    if (/^[0-9a-f-]{36}$/i.test(data[key] || '')) url.searchParams.set(key, data[key]);
  }
  if (/^\d{4}-(0[1-9]|1[0-2])-01$/.test(data.billingMonth || '')) url.searchParams.set('billingMonth', data.billingMonth);
  if (data.kind === 'malfunction' && url.searchParams.has('itemId')) url.hash = `admin-malfunction-${data.itemId}`;
  if (data.kind === 'action' && url.searchParams.has('taskId')) url.hash = `admin-action-${data.taskId}`;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    if (existing) { await existing.navigate(url.href); return existing.focus(); }
    return self.clients.openWindow(url.href);
  })());
});
