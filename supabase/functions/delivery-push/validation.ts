export function validSubscription(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (!value || typeof value !== 'object') return false;
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 4096 || !sub.keys) return false;
  try {
    const url = new URL(sub.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    if (!url.hostname.endsWith('.push.apple.com') && !['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname)) return false;
    if (typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(sub.keys.p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(sub.keys.auth)) return false;
    const decode = (text: string) => atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const key = decode(sub.keys.p256dh);
    return key.length === 65 && key.charCodeAt(0) === 4 && decode(sub.keys.auth).length === 16;
  } catch { return false; }
}

export const appBaseUrls: Record<'admin' | 'delivery', readonly string[]> = {
  admin: ['https://bussan-admin.vercel.app/', 'https://kazuki101213.github.io/test-repo/admin/', 'http://localhost:5173/'],
  delivery: ['https://test-repo-delivery.vercel.app/', 'https://kazuki101213.github.io/test-repo/delivery/', 'http://localhost:5174/'],
};

export function notificationPayload(row: { app_kind: string; kind: string; lot_seq: number; item_id?: string; task_id?: string; invoice_staff_id?: string; billing_month?: string; owner_name?: string; task_name?: string }) {
  if (row.app_kind === 'delivery') return { body: notificationBody(row.kind, row.lot_seq), itemId: row.item_id, tag: `delivery-${row.item_id}-${row.kind}` };
  const docs = ['invoice','receipts'].includes(row.kind);
  const body = row.kind === 'malfunction' ? `【${row.lot_seq}】動作不良の報告が届きました。`
    : row.kind === 'photo_review' ? `【${row.lot_seq}】写真確認のタスクが追加されました。`
    : row.kind === 'action' ? `【${row.lot_seq}】${row.task_name?.includes('ヤフオク') ? 'ヤフオク販売' : row.task_name || '作業'}のタスクが追加されました。`
    : `【${row.billing_month?.slice(0,7)}】${row.owner_name || '担当者'}の書類確認タスクが追加されました。`;
  return { body, kind: row.kind, itemId: row.item_id, taskId: row.task_id, invoiceStaffId: row.invoice_staff_id, billingMonth: row.billing_month,
    tag: docs ? `admin-docs-${row.invoice_staff_id}-${row.billing_month}` : `admin-${row.task_id || row.item_id}-${row.kind}` };
}

export function notificationBody(kind: string, lot: number): string {
  if (kind === 'reply') return `【${lot}】メッセージが届きました`;
  if (kind === 'photo') return `【${lot}】写真が承認されました。`;
  return `【${lot}】新しい担当商品が追加されました。`;
}
